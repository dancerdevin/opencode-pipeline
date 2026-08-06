import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  parseReviewResult,
  parsePhaseResult,
  getStageResult,
  permissionReplyCommand,
  formatWorkingTreeState,
  collectWorkingTreeState,
  validateChatGptSubscriptionProvider,
  validateOpenRouterProvider,
  preflightOpenRouterProvider,
  validatePipelineAgents,
  preflightExistingPipelineServer,
  resolveStageModels,
  resolveStageModelsIfNeeded,
  sendPrompt,
  formatStageDone,
  formatPipelineSummary,
  runPipelineFromCli,
} from '../run-pipeline.mjs';
import {
  formatIssueTask,
  inspectIssueRun,
  isIssueReference,
  issueBranchName,
  parsePipelineCliArgs,
  prepareIssueBranch,
  runIssuePipeline,
  validateIssueForRepository,
} from '../issue-launcher.mjs';
import { runGptPipelineFromCli } from '../run-gpt-pipeline.mjs';
import { DEFAULT_CONFIG_PATH, GPT_CONFIG_PATH, loadConfig } from '../config.mjs';
import { resolveTierModel } from '../resolve-model.mjs';

const execFileAsync = promisify(execFile);

const GPT_STAGE_MODELS = {
  plan: 'openai/gpt-5.6-sol',
  execute: 'openai/gpt-5.6-luna',
  review: 'openai/gpt-5.6-sol',
};

const GPT_STAGE_VARIANTS = {
  plan: 'high',
  execute: 'max',
  review: 'high',
};

const OPENROUTER_STAGE_MODELS = {
  plan: 'openrouter/openai/gpt-5.6-sol',
  execute: 'openrouter/openai/gpt-5.6-luna',
  review: 'openrouter/anthropic/claude-opus-5',
};

const OPENROUTER_STAGE_VARIANTS = {
  plan: 'high',
  execute: 'max',
  review: 'high',
};

function subscriptionRegistry({ connected = ['openai'], missing = [], costs = {} } = {}) {
  const models = {};
  for (const fullModel of Object.values(GPT_STAGE_MODELS)) {
    const modelID = fullModel.slice('openai/'.length);
    if (missing.includes(modelID)) continue;
    models[modelID] = {
      id: modelID,
      providerID: 'openai',
      variants: Object.fromEntries(['none', 'low', 'medium', 'high', 'xhigh', 'max'].map((variant) => [variant, {}])),
      cost: Object.hasOwn(costs, modelID)
        ? costs[modelID]
        : { input: 0, output: 0, cache: { read: 0, write: 0 } },
    };
  }
  return {
    connected,
    all: [{ id: 'openai', models }],
  };
}

function openRouterRegistry({ connected = ['openrouter'], missing = [], variants = {} } = {}) {
  const models = {};
  for (const fullModel of Object.values(OPENROUTER_STAGE_MODELS)) {
    const modelID = fullModel.slice('openrouter/'.length);
    if (missing.includes(modelID)) continue;
    models[modelID] = {
      id: modelID,
      providerID: 'openrouter',
      status: 'active',
      variants: Object.fromEntries(
        Object.entries({ high: {}, max: {}, ...variants[modelID] }).filter(([, value]) => value !== false)
      ),
    };
  }
  return {
    connected,
    all: [{ id: 'openrouter', models }],
  };
}

function response({ ok = true, status = 200, json }) {
  return { ok, status, json: async () => json };
}

function commandStub(expected) {
  const calls = [];
  const execFn = async (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd });
    const next = expected.shift();
    assert.ok(next, `unexpected command: ${command} ${args.join(' ')}`);
    assert.equal(command, next.command);
    assert.deepEqual(args, next.args);
    if (next.error) {
      const error = new Error(next.error);
      error.stderr = next.error;
      throw error;
    }
    return { stdout: next.stdout || '', stderr: '' };
  };
  return { execFn, calls };
}

const PIPELINE_AGENTS = [
  { name: 'pipeline-plan', prompt: 'PLAN_RESULT: READY\nPLAN_RESULT: BLOCKED: <reason>' },
  { name: 'pipeline-execute', prompt: 'EXECUTE_RESULT: COMPLETE\nEXECUTE_RESULT: BLOCKED: <reason>' },
  {
    name: 'pipeline-review',
    prompt: 'REQUIRED_FIXES:\nREVIEW_RESULT: PASS\nREVIEW_RESULT: FAIL: <short, specific, actionable reason>',
  },
];

test('parseReviewResult: clean PASS', () => {
  const { verdict, reason } = parseReviewResult('Looks good.\nREVIEW_RESULT: PASS');
  assert.equal(verdict, 'PASS');
  assert.equal(reason, null);
});

test('parseReviewResult: FAIL carries the reason', () => {
  const { verdict, reason } = parseReviewResult('REVIEW_RESULT: FAIL: tests were not run');
  assert.equal(verdict, 'FAIL');
  assert.equal(reason, 'tests were not run');
});

test('parseReviewResult: FAIL returns every required fix as retry feedback', () => {
  const result = parseReviewResult(
    'REQUIRED_FIXES:\n1. Fix a.js.\n2. Run tests.\n\nNOTES:\nWatch b.js.\n' +
      'REVIEW_RESULT: FAIL: implementation is incomplete'
  );
  assert.equal(result.feedback, '1. Fix a.js.\n2. Run tests.');
});

test('parseReviewResult: FAIL falls back to the reason when the fixes block is missing', () => {
  const result = parseReviewResult('REVIEW_RESULT: FAIL: run the test suite');
  assert.equal(result.feedback, 'run the test suite');
});

test('parseReviewResult: FAIL without a reason gets a placeholder', () => {
  const { verdict, reason } = parseReviewResult('REVIEW_RESULT: FAIL');
  assert.equal(verdict, 'FAIL');
  assert.ok(reason.length > 0);
});

test('parseReviewResult: missing sentinel is a FAIL', () => {
  const { verdict, reason, feedback } = parseReviewResult('The work seems fine, ship it.');
  assert.equal(verdict, 'FAIL');
  assert.match(reason, /did not emit/i);
  assert.equal(feedback, reason);
});

test('parseReviewResult: last sentinel wins (PASS after FAIL)', () => {
  const { verdict } = parseReviewResult('REVIEW_RESULT: FAIL: first\n...\nREVIEW_RESULT: PASS');
  assert.equal(verdict, 'PASS');
});

test('parseReviewResult: last sentinel wins (FAIL after PASS)', () => {
  const { verdict, reason } = parseReviewResult('REVIEW_RESULT: PASS\nREVIEW_RESULT: FAIL: broke it');
  assert.equal(verdict, 'FAIL');
  assert.equal(reason, 'broke it');
});

test('parsePhaseResult: accepts final plan and execute success sentinels', () => {
  assert.deepEqual(parsePhaseResult('1. Edit a.js.\nPLAN_RESULT: READY', 'plan'), {
    status: 'READY',
    reason: null,
  });
  assert.deepEqual(parsePhaseResult('Done.\nEXECUTE_RESULT: COMPLETE', 'execute'), {
    status: 'COMPLETE',
    reason: null,
  });
});

test('parsePhaseResult: carries an explicit blocked reason', () => {
  assert.deepEqual(parsePhaseResult('EXECUTE_RESULT: BLOCKED: missing approval', 'execute'), {
    status: 'BLOCKED',
    reason: 'missing approval',
  });
});

test('parsePhaseResult: rejects a missing or non-final sentinel', () => {
  assert.match(parsePhaseResult('A plan with no status', 'plan').reason, /did not end/i);
  assert.match(parsePhaseResult('PLAN_RESULT: READY\nAdditional prose', 'plan').reason, /did not end/i);
});

test('getStageResult: returns only the final response from the current turn', () => {
  const result = getStageResult(
    [
      { info: { id: 'old', role: 'assistant', cost: 9 }, parts: [{ type: 'text', text: 'old result' }] },
      { info: { id: 'step', role: 'assistant', cost: 2 }, parts: [{ type: 'text', text: 'working' }] },
      { info: { id: 'final', role: 'assistant', cost: 3 }, parts: [{ type: 'text', text: 'final result' }] },
    ],
    new Set(['old'])
  );
  assert.deepEqual(result, { text: 'final result', cost: 5 });
});

test('formatWorkingTreeState: clean tree is explicit', () => {
  const out = formatWorkingTreeState('', '');
  assert.match(out, /\$ git status --porcelain\n\(clean\)/);
  assert.match(out, /no tracked changes/);
});

test('formatWorkingTreeState: shows status and diff verbatim', () => {
  const out = formatWorkingTreeState(' M a.js\n?? b.js', 'diff --git a/a.js b/a.js\n+line');
  assert.match(out, / M a\.js\n\?\? b\.js/);
  assert.match(out, /\$ git diff HEAD\ndiff --git/);
});

test('formatWorkingTreeState: oversized diff is truncated with a pointer', () => {
  const out = formatWorkingTreeState(' M a.js', 'x'.repeat(200_000));
  assert.ok(out.length < 200_000);
  assert.match(out, /diff truncated at 100000 chars/);
});

test('collectWorkingTreeState: non-git dir yields an error note, not a throw', async () => {
  const out = await collectWorkingTreeState('/nonexistent/pipeline-test-dir');
  assert.match(out, /git status failed/);
  assert.match(out, /git diff failed/);
});

test('collectWorkingTreeState: real repo shows modifications and untracked files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pipeline-git-'));
  try {
    const git = (...args) => execFileAsync('git', ['-C', dir, ...args]);
    await git('init');
    await git('config', 'user.email', 'pipeline-test@example.com');
    await git('config', 'user.name', 'Pipeline Test');
    await writeFile(path.join(dir, 'a.txt'), 'one\n');
    await git('add', '.');
    await git('commit', '-m', 'init');
    await writeFile(path.join(dir, 'a.txt'), 'one\ntwo\n');
    await writeFile(path.join(dir, 'b.txt'), 'new\n');
    const out = await collectWorkingTreeState(dir);
    assert.match(out, / M a\.txt/);
    assert.match(out, /\?\? b\.txt/);
    assert.match(out, /\+two/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveTierModel: picks cheapest blended price, weighting completion 4x', () => {
  // a/z has the cheaper prompt price but loses on the blended score.
  const tiers = { cheap: ['a/x', 'a/z'] };
  const pricing = new Map([
    ['a/x', { prompt: 1, completion: 1 }], // blended 5
    ['a/z', { prompt: 0.1, completion: 2 }], // blended 8.1
  ]);
  const winner = resolveTierModel('cheap', tiers, pricing);
  assert.equal(winner.model, 'openrouter/a/x');
});

test('resolveTierModel: skips models missing from live pricing', () => {
  const tiers = { cheap: ['a/gone', 'a/here'] };
  const pricing = new Map([['a/here', { prompt: 1, completion: 1 }]]);
  const winner = resolveTierModel('cheap', tiers, pricing);
  assert.equal(winner.model, 'openrouter/a/here');
});

test('resolveTierModel: unknown tier throws', () => {
  assert.throws(() => resolveTierModel('nope', { cheap: ['a/x'] }, new Map()), /No models configured for tier/);
});

test('resolveTierModel: throws when nothing in the tier is currently priced', () => {
  assert.throws(() => resolveTierModel('cheap', { cheap: ['a/gone'] }, new Map()), /not currently listed|No models in tier/);
});

test('resolveTierModel: filters candidates by requested reasoning effort before pricing', () => {
  const tiers = { smart: ['a/cheap-no-high', 'a/expensive-high'] };
  const pricing = new Map([
    ['a/cheap-no-high', { prompt: 0.1, completion: 0.1, reasoning: { supported_efforts: ['low'] } }],
    ['a/expensive-high', { prompt: 1, completion: 1, reasoning: { supported_efforts: ['high', 'max'] } }],
  ]);
  const winner = resolveTierModel('smart', tiers, pricing, { requiredVariant: 'high' });
  assert.equal(winner.model, 'openrouter/a/expensive-high');
});

test('resolveTierModel: rejects a tier with no model supporting the requested effort', () => {
  const pricing = new Map([
    ['a/model', { prompt: 1, completion: 1, reasoning: { supported_efforts: ['high'] } }],
  ]);
  assert.throws(
    () => resolveTierModel('smart', { smart: ['a/model'] }, pricing, { requiredVariant: 'max' }),
    /supporting reasoning effort "max"/
  );
});

test('permissionReplyCommand: includes directory-scoped URL, request id, and reply', () => {
  const cmd = permissionReplyCommand('http://127.0.0.1:4747', '/tmp/my dir', 'req123', 'once');
  assert.match(cmd, /permission\/req123\/reply/);
  assert.match(cmd, /directory=%2Ftmp%2Fmy%20dir/);
  assert.match(cmd, /"reply":"once"/);
});

test('issue CLI: parses issue numbers, URLs, legacy tasks, and help', () => {
  assert.deepEqual(parsePipelineCliArgs(['--issue', '123', '/repo']), {
    mode: 'issue',
    issueRef: '123',
    targetDirArg: '/repo',
  });
  assert.equal(parsePipelineCliArgs(['--issue', 'https://github.com/acme/app/issues/9']).mode, 'issue');
  assert.deepEqual(parsePipelineCliArgs(['fix the bug', '/repo']), {
    mode: 'task',
    task: 'fix the bug',
    targetDirArg: '/repo',
  });
  assert.deepEqual(parsePipelineCliArgs(['--help']), { mode: 'help' });
  assert.equal(parsePipelineCliArgs(['--issue', 'nope']).mode, 'error');
  assert.equal(parsePipelineCliArgs([]).mode, 'error');
  assert.equal(isIssueReference('0'), false);
  assert.equal(isIssueReference('ftp://github.com/acme/app/issues/1'), false);
});

test('GPT CLI: issue mode defaults to the existing localhost server and preserves legacy mode', async () => {
  let issueInput;
  const issueExit = await runGptPipelineFromCli(['--issue', '42', '/repo'], {
    env: {},
    runIssuePipelineFn: async (input) => {
      issueInput = input;
      return 7;
    },
  });
  assert.equal(issueExit, 7);
  assert.equal(issueInput.serverUrl, 'http://127.0.0.1:4747');
  assert.equal(issueInput.configPath, GPT_CONFIG_PATH);

  let taskInput;
  await runGptPipelineFromCli(['do it', '/repo'], {
    runPipelineFn: async (input) => {
      taskInput = input;
      return 0;
    },
  });
  assert.equal(taskInput.task, 'do it');
  assert.equal(taskInput.configPath, GPT_CONFIG_PATH);
});

test('standard CLI: issue mode honors PIPELINE_CONFIG and defaults to OpenRouter config', async () => {
  let customInput;
  await runPipelineFromCli({
    args: ['--issue', '42', '/repo'],
    env: { PIPELINE_CONFIG: '/tmp/custom.json', PIPELINE_SERVER_PORT: '5555' },
    runIssuePipelineFn: async (input) => {
      customInput = input;
      return 0;
    },
  });
  assert.equal(customInput.configPath, '/tmp/custom.json');
  assert.equal(customInput.serverUrl, 'http://127.0.0.1:5555');

  let defaultInput;
  await runPipelineFromCli({
    args: ['--issue', '42', '/repo'],
    env: {},
    runIssuePipelineFn: async (input) => {
      defaultInput = input;
      return 0;
    },
  });
  assert.equal(defaultInput.configPath, DEFAULT_CONFIG_PATH);
});

test('issueBranchName: produces deterministic capped ASCII branch names', () => {
  assert.equal(issueBranchName(12, 'Fix Café / Empty State!'), 'issue-12-fix-cafe-empty-state');
  assert.equal(issueBranchName(12, '✨✨'), 'issue-12');
  assert.ok(issueBranchName(999, 'x'.repeat(200)).length <= 80);
});

test('formatIssueTask: preserves body, labels, and chronological comments', () => {
  const task = formatIssueTask(
    {
      number: 4,
      title: 'Improve launch',
      url: 'https://github.com/acme/app/issues/4',
      body: 'Acceptance criteria here.',
      labels: [{ name: 'feature' }, { name: 'client' }],
      comments: [
        { author: { login: 'b' }, createdAt: '2026-01-02T00:00:00Z', body: 'Second' },
        { author: { login: 'a' }, createdAt: '2026-01-01T00:00:00Z', body: 'First' },
      ],
    },
    { nameWithOwner: 'acme/app' }
  );
  assert.match(task, /Labels: feature, client/);
  assert.match(task, /Issue body:\nAcceptance criteria here\./);
  assert.ok(task.indexOf('First') < task.indexOf('Second'));
});

test('validateIssueForRepository: rejects closed and wrong-repository issues', () => {
  const repository = { nameWithOwner: 'acme/app' };
  assert.throws(
    () => validateIssueForRepository({ number: 1, title: 'x', url: 'https://github.com/acme/app/issues/1', state: 'CLOSED' }, repository),
    /only runs open issues/
  );
  assert.throws(
    () => validateIssueForRepository({ number: 1, title: 'x', url: 'https://github.com/other/app/issues/1', state: 'OPEN' }, repository),
    /belongs to other\/app/
  );
});

test('inspectIssueRun: resolves a clean repository and complete issue packet', async () => {
  const repository = {
    nameWithOwner: 'acme/app',
    url: 'https://github.com/acme/app',
    defaultBranchRef: { name: 'main' },
  };
  const issue = {
    number: 8,
    title: 'Add retries',
    body: 'Do the thing.',
    url: 'https://github.com/acme/app/issues/8',
    state: 'OPEN',
    labels: [],
    comments: [],
  };
  const { execFn, calls } = commandStub([
    { command: 'git', args: ['rev-parse', '--show-toplevel'], stdout: '/repo\n' },
    { command: 'git', args: ['status', '--porcelain'] },
    { command: 'git', args: ['branch', '--show-current'], stdout: 'main\n' },
    { command: 'git', args: ['remote', 'get-url', 'origin'], stdout: 'git@github.com:acme/app.git\n' },
    { command: 'gh', args: ['repo', 'view', '--json', 'nameWithOwner,url,defaultBranchRef'], stdout: JSON.stringify(repository) },
    { command: 'gh', args: ['issue', 'view', '8', '--repo', 'acme/app', '--json', 'number,title,body,url,state,labels,comments'], stdout: JSON.stringify(issue) },
  ]);
  const context = await inspectIssueRun('8', '/repo/subdir', { execFn });
  assert.equal(context.root, '/repo');
  assert.equal(context.issueBranch, 'issue-8-add-retries');
  assert.match(context.task, /Do the thing/);
  assert.equal(calls[1].cwd, '/repo');
});

test('inspectIssueRun: rejects a dirty worktree before GitHub calls', async () => {
  const { execFn, calls } = commandStub([
    { command: 'git', args: ['rev-parse', '--show-toplevel'], stdout: '/repo\n' },
    { command: 'git', args: ['status', '--porcelain'], stdout: ' M app.js\n' },
  ]);
  await assert.rejects(() => inspectIssueRun('8', '/repo', { execFn }), /clean working tree/);
  assert.equal(calls.length, 2);
});

test('inspectIssueRun: rejects detached HEAD, missing origin, and malformed GitHub JSON', async () => {
  const detached = commandStub([
    { command: 'git', args: ['rev-parse', '--show-toplevel'], stdout: '/repo\n' },
    { command: 'git', args: ['status', '--porcelain'] },
    { command: 'git', args: ['branch', '--show-current'] },
  ]);
  await assert.rejects(() => inspectIssueRun('8', '/repo', detached), /detached HEAD/);

  const missingOrigin = commandStub([
    { command: 'git', args: ['rev-parse', '--show-toplevel'], stdout: '/repo\n' },
    { command: 'git', args: ['status', '--porcelain'] },
    { command: 'git', args: ['branch', '--show-current'], stdout: 'main\n' },
    { command: 'git', args: ['remote', 'get-url', 'origin'], error: 'No such remote' },
  ]);
  await assert.rejects(() => inspectIssueRun('8', '/repo', missingOrigin), /checking origin remote failed/);

  const malformed = commandStub([
    { command: 'git', args: ['rev-parse', '--show-toplevel'], stdout: '/repo\n' },
    { command: 'git', args: ['status', '--porcelain'] },
    { command: 'git', args: ['branch', '--show-current'], stdout: 'main\n' },
    { command: 'git', args: ['remote', 'get-url', 'origin'], stdout: 'origin\n' },
    { command: 'gh', args: ['repo', 'view', '--json', 'nameWithOwner,url,defaultBranchRef'], stdout: '{bad' },
  ]);
  await assert.rejects(() => inspectIssueRun('8', '/repo', malformed), /malformed JSON/);
});

test('prepareIssueBranch: fetches, verifies, and creates from synchronized default', async () => {
  const context = {
    root: '/repo',
    branch: 'main',
    issueBranch: 'issue-8-add-retries',
    repository: { defaultBranchRef: { name: 'main' } },
  };
  const { execFn } = commandStub([
    { command: 'git', args: ['fetch', 'origin', 'main'] },
    { command: 'git', args: ['rev-parse', 'refs/heads/main'], stdout: 'abc\n' },
    { command: 'git', args: ['rev-parse', 'refs/remotes/origin/main'], stdout: 'abc\n' },
    { command: 'git', args: ['branch', '--list', 'issue-8-add-retries'] },
    { command: 'git', args: ['switch', '-c', 'issue-8-add-retries'] },
  ]);
  assert.deepEqual(await prepareIssueBranch(context, { execFn }), {
    branch: 'issue-8-add-retries',
    created: true,
  });
});

test('prepareIssueBranch: preserves prepared feature branches and rejects unsafe defaults', async () => {
  const feature = {
    root: '/repo',
    branch: 'custom-feature',
    issueBranch: 'issue-8-add-retries',
    repository: { defaultBranchRef: { name: 'main' } },
  };
  const noCommands = commandStub([]);
  assert.deepEqual(await prepareIssueBranch(feature, noCommands), {
    branch: 'custom-feature',
    created: false,
  });

  const diverged = { ...feature, branch: 'main' };
  const divergedCommands = commandStub([
    { command: 'git', args: ['fetch', 'origin', 'main'] },
    { command: 'git', args: ['rev-parse', 'refs/heads/main'], stdout: 'local\n' },
    { command: 'git', args: ['rev-parse', 'refs/remotes/origin/main'], stdout: 'remote\n' },
  ]);
  await assert.rejects(() => prepareIssueBranch(diverged, divergedCommands), /does not match/);

  const existingCommands = commandStub([
    { command: 'git', args: ['fetch', 'origin', 'main'] },
    { command: 'git', args: ['rev-parse', 'refs/heads/main'], stdout: 'same\n' },
    { command: 'git', args: ['rev-parse', 'refs/remotes/origin/main'], stdout: 'same\n' },
    { command: 'git', args: ['branch', '--list', 'issue-8-add-retries'], stdout: '  issue-8-add-retries\n' },
  ]);
  await assert.rejects(() => prepareIssueBranch(diverged, existingCommands), /already exists/);
});

test('pipeline agent preflight: validates names and current prompt contracts', async () => {
  assert.equal(validatePipelineAgents(PIPELINE_AGENTS), true);
  assert.throws(
    () => validatePipelineAgents(PIPELINE_AGENTS.map((agent) => agent.name === 'pipeline-plan' ? { ...agent, prompt: 'old' } : agent)),
    /pipeline-plan is stale/
  );
  assert.throws(() => validatePipelineAgents([]), /pipeline-plan is not loaded/);

  const urls = [];
  await preflightExistingPipelineServer('http://127.0.0.1:4747', '/repo path', {
    fetchFn: async (url) => {
      urls.push(url);
      return urls.length === 1 ? response({}) : response({ json: PIPELINE_AGENTS });
    },
  });
  assert.match(urls[0], /global\/health$/);
  assert.match(urls[1], /directory=%2Frepo%20path/);

  await assert.rejects(
    () => preflightExistingPipelineServer('http://127.0.0.1:4747', '/repo', {
      fetchFn: async () => response({ ok: false, status: 503 }),
    }),
    /global\/health returned HTTP 503/
  );
});

test('runIssuePipeline: server failure occurs before fetch or branch creation', async () => {
  const repository = {
    nameWithOwner: 'acme/app',
    url: 'https://github.com/acme/app',
    defaultBranchRef: { name: 'main' },
  };
  const issue = {
    number: 8,
    title: 'Add retries',
    body: '',
    url: 'https://github.com/acme/app/issues/8',
    state: 'OPEN',
    labels: [],
    comments: [],
  };
  const commands = commandStub([
    { command: 'git', args: ['rev-parse', '--show-toplevel'], stdout: '/repo\n' },
    { command: 'git', args: ['status', '--porcelain'] },
    { command: 'git', args: ['branch', '--show-current'], stdout: 'main\n' },
    { command: 'git', args: ['remote', 'get-url', 'origin'], stdout: 'origin\n' },
    { command: 'gh', args: ['repo', 'view', '--json', 'nameWithOwner,url,defaultBranchRef'], stdout: JSON.stringify(repository) },
    { command: 'gh', args: ['issue', 'view', '8', '--repo', 'acme/app', '--json', 'number,title,body,url,state,labels,comments'], stdout: JSON.stringify(issue) },
  ]);
  await assert.rejects(
    () => runIssuePipeline(
      { issueRef: '8', targetDirArg: '/repo', serverUrl: 'http://server' },
      {
        execFn: commands.execFn,
        loadConfigFn: async () => ({ billingMode: 'chatgpt-subscription', stageModels: GPT_STAGE_MODELS }),
        preflightServerFn: async () => { throw new Error('server unavailable'); },
      }
    ),
    /server unavailable/
  );
  assert.equal(commands.calls.length, 6);
});

test('runIssuePipeline: completes all preflights before branch mutation and forwards task', async () => {
  const repository = {
    nameWithOwner: 'acme/app',
    url: 'https://github.com/acme/app',
    defaultBranchRef: { name: 'main' },
  };
  const issue = {
    number: 8,
    title: 'Add retries',
    body: 'Do it.',
    url: 'https://github.com/acme/app/issues/8',
    state: 'OPEN',
    labels: [],
    comments: [],
  };
  const commands = commandStub([
    { command: 'git', args: ['rev-parse', '--show-toplevel'], stdout: '/repo\n' },
    { command: 'git', args: ['status', '--porcelain'] },
    { command: 'git', args: ['branch', '--show-current'], stdout: 'main\n' },
    { command: 'git', args: ['remote', 'get-url', 'origin'], stdout: 'origin\n' },
    { command: 'gh', args: ['repo', 'view', '--json', 'nameWithOwner,url,defaultBranchRef'], stdout: JSON.stringify(repository) },
    { command: 'gh', args: ['issue', 'view', '8', '--repo', 'acme/app', '--json', 'number,title,body,url,state,labels,comments'], stdout: JSON.stringify(issue) },
    { command: 'git', args: ['fetch', 'origin', 'main'] },
    { command: 'git', args: ['rev-parse', 'refs/heads/main'], stdout: 'same\n' },
    { command: 'git', args: ['rev-parse', 'refs/remotes/origin/main'], stdout: 'same\n' },
    { command: 'git', args: ['branch', '--list', 'issue-8-add-retries'] },
    { command: 'git', args: ['switch', '-c', 'issue-8-add-retries'] },
  ]);
  const events = [];
  let pipelineInput;
  const exitCode = await runIssuePipeline(
    { issueRef: '8', targetDirArg: '/repo', serverUrl: 'http://server', configPath: GPT_CONFIG_PATH },
    {
      execFn: commands.execFn,
      loadConfigFn: async () => ({ billingMode: 'chatgpt-subscription', stageModels: GPT_STAGE_MODELS }),
      preflightServerFn: async () => events.push('server'),
      preflightSubscriptionFn: async () => events.push('subscription'),
      resolveStageModelsFn: async () => {
        events.push('resolve');
        return { plan: { model: 'p' }, execute: { model: 'e' }, review: { model: 'r' } };
      },
      runPipelineFn: async (input) => {
        events.push('pipeline');
        pipelineInput = input;
        return 0;
      },
    }
  );
  assert.equal(exitCode, 0);
  assert.deepEqual(events, ['server', 'subscription', 'resolve', 'pipeline']);
  assert.match(pipelineInput.task, /GitHub issue #8/);
  assert.equal(pipelineInput.preflightComplete, true);
  assert.equal(pipelineInput.configPath, GPT_CONFIG_PATH);
  assert.equal(pipelineInput.resolvedStageModelsArg.plan.model, 'p');
});

test('runIssuePipeline: OpenRouter resolves pricing once, skips GPT preflight, and forwards snapshot', async () => {
  const repository = {
    nameWithOwner: 'acme/app',
    url: 'https://github.com/acme/app',
    defaultBranchRef: { name: 'main' },
  };
  const issue = {
    number: 8,
    title: 'Add retries',
    body: 'Do it.',
    url: 'https://github.com/acme/app/issues/8',
    state: 'OPEN',
    labels: [],
    comments: [],
  };
  const commands = commandStub([
    { command: 'git', args: ['rev-parse', '--show-toplevel'], stdout: '/repo\n' },
    { command: 'git', args: ['status', '--porcelain'] },
    { command: 'git', args: ['branch', '--show-current'], stdout: 'feature/already-prepared\n' },
    { command: 'git', args: ['remote', 'get-url', 'origin'], stdout: 'origin\n' },
    { command: 'gh', args: ['repo', 'view', '--json', 'nameWithOwner,url,defaultBranchRef'], stdout: JSON.stringify(repository) },
    { command: 'gh', args: ['issue', 'view', '8', '--repo', 'acme/app', '--json', 'number,title,body,url,state,labels,comments'], stdout: JSON.stringify(issue) },
  ]);
  const snapshot = { plan: { model: 'a' }, execute: { model: 'b' }, review: { model: 'c' } };
  let resolveCalls = 0;
  let subscriptionCalls = 0;
  let routePreflightCalls = 0;
  let pipelineInput;
  await runIssuePipeline(
    { issueRef: '8', targetDirArg: '/repo', serverUrl: 'http://server', configPath: DEFAULT_CONFIG_PATH },
    {
      execFn: commands.execFn,
      loadConfigFn: async () => ({ billingMode: 'openrouter', modelStrategy: 'tiered' }),
      preflightServerFn: async () => {},
      preflightSubscriptionFn: async () => { subscriptionCalls += 1; },
      preflightOpenRouterFn: async (serverUrl, dir, resolved) => {
        routePreflightCalls += 1;
        assert.equal(serverUrl, 'http://server');
        assert.equal(dir, '/repo');
        assert.equal(resolved, snapshot);
      },
      resolveStageModelsFn: async () => {
        resolveCalls += 1;
        return snapshot;
      },
      runPipelineFn: async (input) => {
        pipelineInput = input;
        return 0;
      },
    }
  );
  assert.equal(resolveCalls, 1);
  assert.equal(subscriptionCalls, 0);
  assert.equal(routePreflightCalls, 1);
  assert.equal(pipelineInput.resolvedStageModelsArg, snapshot);
  assert.equal(pipelineInput.configPath, DEFAULT_CONFIG_PATH);
});

test('runIssuePipeline: OpenRouter pricing failure happens before branch creation', async () => {
  const repository = {
    nameWithOwner: 'acme/app',
    url: 'https://github.com/acme/app',
    defaultBranchRef: { name: 'main' },
  };
  const issue = {
    number: 8,
    title: 'Add retries',
    body: '',
    url: 'https://github.com/acme/app/issues/8',
    state: 'OPEN',
    labels: [],
    comments: [],
  };
  const commands = commandStub([
    { command: 'git', args: ['rev-parse', '--show-toplevel'], stdout: '/repo\n' },
    { command: 'git', args: ['status', '--porcelain'] },
    { command: 'git', args: ['branch', '--show-current'], stdout: 'main\n' },
    { command: 'git', args: ['remote', 'get-url', 'origin'], stdout: 'origin\n' },
    { command: 'gh', args: ['repo', 'view', '--json', 'nameWithOwner,url,defaultBranchRef'], stdout: JSON.stringify(repository) },
    { command: 'gh', args: ['issue', 'view', '8', '--repo', 'acme/app', '--json', 'number,title,body,url,state,labels,comments'], stdout: JSON.stringify(issue) },
  ]);
  await assert.rejects(
    () => runIssuePipeline(
      { issueRef: '8', targetDirArg: '/repo', serverUrl: 'http://server', configPath: DEFAULT_CONFIG_PATH },
      {
        execFn: commands.execFn,
        loadConfigFn: async () => ({ billingMode: 'openrouter', modelStrategy: 'tiered' }),
        preflightServerFn: async () => {},
        resolveStageModelsFn: async () => { throw new Error('pricing unavailable'); },
      }
    ),
    /pricing unavailable/
  );
  assert.equal(commands.calls.length, 6);
});

test('runIssuePipeline: OpenRouter model preflight failure happens before branch creation', async () => {
  const repository = {
    nameWithOwner: 'acme/app',
    url: 'https://github.com/acme/app',
    defaultBranchRef: { name: 'main' },
  };
  const issue = {
    number: 8,
    title: 'Add retries',
    body: '',
    url: 'https://github.com/acme/app/issues/8',
    state: 'OPEN',
    labels: [],
    comments: [],
  };
  const commands = commandStub([
    { command: 'git', args: ['rev-parse', '--show-toplevel'], stdout: '/repo\n' },
    { command: 'git', args: ['status', '--porcelain'] },
    { command: 'git', args: ['branch', '--show-current'], stdout: 'main\n' },
    { command: 'git', args: ['remote', 'get-url', 'origin'], stdout: 'origin\n' },
    { command: 'gh', args: ['repo', 'view', '--json', 'nameWithOwner,url,defaultBranchRef'], stdout: JSON.stringify(repository) },
    { command: 'gh', args: ['issue', 'view', '8', '--repo', 'acme/app', '--json', 'number,title,body,url,state,labels,comments'], stdout: JSON.stringify(issue) },
  ]);
  await assert.rejects(
    () => runIssuePipeline(
      { issueRef: '8', targetDirArg: '/repo', serverUrl: 'http://server', configPath: DEFAULT_CONFIG_PATH },
      {
        execFn: commands.execFn,
        loadConfigFn: async () => ({ billingMode: 'openrouter', modelStrategy: 'tiered' }),
        preflightServerFn: async () => {},
        resolveStageModelsFn: async () => ({ plan: { model: 'a' }, execute: { model: 'b' }, review: { model: 'c' } }),
        preflightOpenRouterFn: async () => { throw new Error('model route unavailable'); },
      }
    ),
    /model route unavailable/
  );
  assert.equal(commands.calls.length, 6);
});

test('loadConfig: defaults stageTiers and maxRetries', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pipeline-config-'));
  try {
    const p = path.join(dir, 'pipeline.config.json');
    await writeFile(p, JSON.stringify({ tiers: { cheap: ['a/x'] } }));
    const config = await loadConfig(p);
    assert.equal(config.modelStrategy, 'tiered');
    assert.equal(config.billingMode, 'openrouter');
    assert.deepEqual(config.tiers, { cheap: ['a/x'] });
    assert.deepEqual(config.stageTiers, { plan: 'smart', execute: 'cheap', review: 'very-smart' });
    assert.deepEqual(config.stageVariants, {});
    assert.equal(config.maxRetries, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadConfig: explicit stageTiers and maxRetries win', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pipeline-config-'));
  try {
    const p = path.join(dir, 'pipeline.config.json');
    await writeFile(
      p,
      JSON.stringify({ tiers: { cheap: ['a/x'] }, stageTiers: { plan: 'cheap' }, maxRetries: 5 })
    );
    const config = await loadConfig(p);
    assert.equal(config.stageTiers.plan, 'cheap');
    assert.equal(config.stageTiers.execute, 'cheap'); // default fills the rest
    assert.equal(config.maxRetries, 5);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadConfig: tiered configs accept per-stage reasoning variants', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pipeline-config-'));
  try {
    const p = path.join(dir, 'pipeline.config.json');
    await writeFile(
      p,
      JSON.stringify({
        tiers: { reasoning: ['a/x'], implementation: ['a/y'] },
        stageTiers: { plan: 'reasoning', execute: 'implementation', review: 'reasoning' },
        stageVariants: { plan: 'high', execute: 'max', review: 'high' },
      })
    );
    const config = await loadConfig(p);
    assert.equal(config.modelStrategy, 'tiered');
    assert.equal(config.billingMode, 'openrouter');
    assert.deepEqual(config.stageVariants, { plan: 'high', execute: 'max', review: 'high' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadConfig: bundled OpenRouter config pins the requested tiers and variants', async () => {
  const config = await loadConfig(DEFAULT_CONFIG_PATH);
  assert.equal(config.modelStrategy, 'tiered');
  assert.equal(config.billingMode, 'openrouter');
  assert.deepEqual(config.tiers, {
    'planner-review': ['openai/gpt-5.6-sol', 'anthropic/claude-opus-5'],
    implementation: ['openai/gpt-5.6-luna'],
  });
  assert.deepEqual(config.stageTiers, {
    plan: 'planner-review',
    execute: 'implementation',
    review: 'planner-review',
  });
  assert.deepEqual(config.stageVariants, OPENROUTER_STAGE_VARIANTS);
});

test('loadConfig: missing tiers is an error', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pipeline-config-'));
  try {
    const p = path.join(dir, 'pipeline.config.json');
    await writeFile(p, JSON.stringify({ maxRetries: 1 }));
    await assert.rejects(() => loadConfig(p), /"tiers"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadConfig: missing file is an error', async () => {
  await assert.rejects(() => loadConfig('/nonexistent/pipeline.config.json'), /Could not read/);
});

test('loadConfig: bundled GPT config pins the requested models and variants', async () => {
  const config = await loadConfig(GPT_CONFIG_PATH);
  assert.equal(config.modelStrategy, 'fixed');
  assert.equal(config.billingMode, 'chatgpt-subscription');
  assert.deepEqual(config.stageModels, GPT_STAGE_MODELS);
  assert.deepEqual(config.stageVariants, GPT_STAGE_VARIANTS);
  assert.equal(config.maxRetries, 2);
});

test('loadConfig: fixed config requires every stage model', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pipeline-config-'));
  try {
    const p = path.join(dir, 'fixed.json');
    await writeFile(
      p,
      JSON.stringify({
        modelStrategy: 'fixed',
        billingMode: 'chatgpt-subscription',
        stageModels: { plan: 'openai/a', execute: 'openai/b' },
      })
    );
    await assert.rejects(() => loadConfig(p), /stageModels\.review/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadConfig: fixed config rejects malformed model IDs', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pipeline-config-'));
  try {
    const p = path.join(dir, 'fixed.json');
    await writeFile(
      p,
      JSON.stringify({
        modelStrategy: 'fixed',
        billingMode: 'chatgpt-subscription',
        stageModels: { ...GPT_STAGE_MODELS, execute: 'gpt-5.6-luna' },
      })
    );
    await assert.rejects(() => loadConfig(p), /stageModels\.execute.*provider\/model/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadConfig: malformed JSON reports the config path', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pipeline-config-'));
  try {
    const p = path.join(dir, 'broken.json');
    await writeFile(p, '{ nope');
    await assert.rejects(() => loadConfig(p), /not valid JSON/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadConfig: fixed strategy rejects tier fields', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pipeline-config-'));
  try {
    const p = path.join(dir, 'mixed.json');
    await writeFile(
      p,
      JSON.stringify({
        modelStrategy: 'fixed',
        billingMode: 'chatgpt-subscription',
        stageModels: GPT_STAGE_MODELS,
        tiers: { cheap: ['openai/a'] },
      })
    );
    await assert.rejects(() => loadConfig(p), /cannot mix/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadConfig: tiered strategy rejects fixed model fields', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pipeline-config-'));
  try {
    const p = path.join(dir, 'mixed.json');
    await writeFile(
      p,
      JSON.stringify({
        modelStrategy: 'tiered',
        tiers: { cheap: ['openai/a'] },
        stageModels: GPT_STAGE_MODELS,
      })
    );
    await assert.rejects(() => loadConfig(p), /cannot mix/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveStageModels: fixed GPT mapping never fetches OpenRouter pricing', async () => {
  const config = await loadConfig(GPT_CONFIG_PATH);
  let pricingCalled = false;
  const resolved = await resolveStageModels(config, {
    fetchPricingFn: async () => {
      pricingCalled = true;
      throw new Error('must not be called');
    },
  });
  assert.equal(pricingCalled, false);
  assert.deepEqual(
    Object.fromEntries(Object.entries(resolved).map(([stage, value]) => [stage, value.model])),
    GPT_STAGE_MODELS
  );
});

test('resolveStageModels: tiered OpenRouter mapping carries variants and filters unsupported candidates', async () => {
  const config = {
    modelStrategy: 'tiered',
    stageTiers: {
      plan: 'planner-review',
      execute: 'implementation',
      review: 'planner-review',
    },
    stageVariants: OPENROUTER_STAGE_VARIANTS,
    tiers: {
      'planner-review': ['openai/gpt-5.6-sol', 'anthropic/claude-opus-5'],
      implementation: ['openai/gpt-5.6-luna'],
    },
  };
  let pricingCalls = 0;
  const resolved = await resolveStageModels(config, {
    fetchPricingFn: async () => {
      pricingCalls += 1;
      return new Map([
        ['openai/gpt-5.6-sol', { prompt: 1, completion: 1, reasoning: { supported_efforts: ['high', 'max'] } }],
        ['anthropic/claude-opus-5', { prompt: 2, completion: 2, reasoning: { supported_efforts: ['high', 'max'] } }],
        ['openai/gpt-5.6-luna', { prompt: 1, completion: 1, reasoning: { supported_efforts: ['max'] } }],
      ]);
    },
  });
  assert.equal(pricingCalls, 1);
  assert.equal(resolved.plan.model, 'openrouter/openai/gpt-5.6-sol');
  assert.equal(resolved.plan.variant, 'high');
  assert.equal(resolved.execute.model, 'openrouter/openai/gpt-5.6-luna');
  assert.equal(resolved.execute.variant, 'max');
  assert.equal(resolved.review.model, 'openrouter/openai/gpt-5.6-sol');
  assert.equal(resolved.review.variant, 'high');
});

test('sendPrompt: forwards the configured OpenCode model variant', async () => {
  let request;
  await sendPrompt(
    'http://server',
    '/repo',
    'session-1',
    {
      agent: 'pipeline-plan',
      model: 'openai/gpt-5.6-sol',
      variant: 'high',
      prompt: 'Task: test',
    },
    {
      fetchFn: async (url, options) => {
        request = { url, options };
        return response({ ok: true });
      },
    }
  );
  assert.equal(request.url, 'http://server/session/session-1/prompt_async?directory=%2Frepo');
  assert.deepEqual(JSON.parse(request.options.body), {
    agent: 'pipeline-plan',
    model: { providerID: 'openai', modelID: 'gpt-5.6-sol' },
    variant: 'high',
    parts: [{ type: 'text', text: 'Task: test' }],
  });
});

test('resolveStageModelsIfNeeded: preserves a preflight snapshot without resolving again', async () => {
  const snapshot = { plan: { model: 'a' }, execute: { model: 'b' }, review: { model: 'c' } };
  let calls = 0;
  const resolved = await resolveStageModelsIfNeeded({}, snapshot, {
    resolveFn: async () => {
      calls += 1;
      return {};
    },
  });
  assert.equal(resolved, snapshot);
  assert.equal(calls, 0);
});

test('GPT preflight: rejects disconnected OpenAI', () => {
  assert.throws(
    () => validateChatGptSubscriptionProvider(subscriptionRegistry({ connected: ['openrouter'] }), GPT_STAGE_MODELS),
    /OpenAI is not connected[\s\S]*opencode auth login/
  );
});

test('sendPrompt: forwards OpenRouter model IDs and variants', async () => {
  let request;
  await sendPrompt(
    'http://server',
    '/repo',
    'session-1',
    {
      agent: 'pipeline-execute',
      model: 'openrouter/openai/gpt-5.6-luna',
      variant: 'max',
      prompt: 'Task: test',
    },
    {
      fetchFn: async (url, options) => {
        request = { url, options };
        return response({ ok: true });
      },
    }
  );
  assert.deepEqual(JSON.parse(request.options.body).model, {
    providerID: 'openrouter',
    modelID: 'openai/gpt-5.6-luna',
  });
  assert.equal(JSON.parse(request.options.body).variant, 'max');
});

test('GPT preflight: rejects a missing required model', () => {
  assert.throws(
    () =>
      validateChatGptSubscriptionProvider(
        subscriptionRegistry({ missing: ['gpt-5.6-luna'] }),
        GPT_STAGE_MODELS
      ),
    /openai\/gpt-5\.6-luna is not available/
  );
});

test('GPT preflight: rejects missing cost metadata', () => {
  assert.throws(
    () =>
      validateChatGptSubscriptionProvider(
        subscriptionRegistry({ costs: { 'gpt-5.6-sol': undefined } }),
        GPT_STAGE_MODELS
      ),
    /cost metadata is missing/
  );
});

test('GPT preflight: rejects nonzero API-key pricing', () => {
  assert.throws(
    () =>
      validateChatGptSubscriptionProvider(
        subscriptionRegistry({
          costs: {
            'gpt-5.6-sol': { input: 5, output: 30, cache: { read: 0.5, write: 6.25 } },
          },
        }),
        GPT_STAGE_MODELS
      ),
    /does not have zero-valued subscription cost metadata[\s\S]*not zero/
  );
});

test('GPT preflight: accepts connected models with zero subscription costs', () => {
  assert.equal(validateChatGptSubscriptionProvider(subscriptionRegistry(), GPT_STAGE_MODELS), true);
});

test('GPT preflight: accepts configured reasoning variants', () => {
  assert.equal(
    validateChatGptSubscriptionProvider(subscriptionRegistry(), GPT_STAGE_MODELS, GPT_STAGE_VARIANTS),
    true
  );
});

test('GPT preflight: rejects an unavailable reasoning variant', () => {
  const registry = subscriptionRegistry();
  delete registry.all[0].models['gpt-5.6-luna'].variants.max;
  assert.throws(
    () => validateChatGptSubscriptionProvider(registry, GPT_STAGE_MODELS, GPT_STAGE_VARIANTS),
    /gpt-5\.6-luna does not expose the configured execute variant "max"/
  );
});

test('OpenRouter preflight: accepts connected resolved models and variants', () => {
  const resolved = Object.fromEntries(
    Object.entries(OPENROUTER_STAGE_MODELS).map(([stage, model]) => [stage, {
      model,
      variant: OPENROUTER_STAGE_VARIANTS[stage],
    }])
  );
  assert.equal(validateOpenRouterProvider(openRouterRegistry(), resolved), true);
});

test('OpenRouter preflight: rejects a missing model or unavailable variant', () => {
  const resolved = Object.fromEntries(
    Object.entries(OPENROUTER_STAGE_MODELS).map(([stage, model]) => [stage, {
      model,
      variant: OPENROUTER_STAGE_VARIANTS[stage],
    }])
  );
  assert.throws(
    () => validateOpenRouterProvider(
      openRouterRegistry({ missing: ['openai/gpt-5.6-luna'] }),
      resolved
    ),
    /openai\/gpt-5\.6-luna is not available/
  );
  assert.throws(
    () => validateOpenRouterProvider(
      openRouterRegistry({ variants: { 'openai/gpt-5.6-luna': { max: false } } }),
      resolved
    ),
    /gpt-5\.6-luna does not expose the configured execute variant "max"/
  );
});

test('OpenRouter preflight: queries the directory-scoped provider registry', async () => {
  const urls = [];
  const resolved = Object.fromEntries(
    Object.entries(OPENROUTER_STAGE_MODELS).map(([stage, model]) => [stage, {
      model,
      variant: OPENROUTER_STAGE_VARIANTS[stage],
    }])
  );
  await preflightOpenRouterProvider('http://127.0.0.1:4747', '/repo path', resolved, {
    fetchFn: async (url) => {
      urls.push(url);
      return response({ json: openRouterRegistry() });
    },
  });
  assert.match(urls[0], /provider\?directory=%2Frepo%20path/);
});

test('GPT output: reports subscription allowance without a dollar receipt', () => {
  const result = { text: '', cost: 12.34 };
  const done = formatStageDone('plan', result, 'chatgpt-subscription');
  const summary = formatPipelineSummary(
    [{ stage: 'plan', model: GPT_STAGE_MODELS.plan, cost: result.cost }],
    result.cost,
    { verdict: 'PASS', reason: null },
    'chatgpt-subscription'
  );
  assert.match(`${done}\n${summary}`, /ChatGPT subscription allowance/);
  assert.doesNotMatch(`${done}\n${summary}`, /\$/);
  assert.doesNotMatch(summary, /total cost/i);
});

test('OpenRouter output: preserves stage and total dollar costs', () => {
  const result = { text: '', cost: 0.125 };
  assert.equal(formatStageDone('plan', result, 'openrouter'), '[plan] done (cost $0.125000)');
  const summary = formatPipelineSummary(
    [{ stage: 'plan', model: 'openrouter/a/x', cost: result.cost }],
    result.cost,
    { verdict: 'PASS', reason: null },
    'openrouter'
  );
  assert.match(summary, /\$0\.125000/);
  assert.match(summary, /total cost/);
});

test('OpenRouter output: reports configured effort variants with dollar costs', () => {
  const summary = formatPipelineSummary(
    [{ stage: 'execute', model: OPENROUTER_STAGE_MODELS.execute, variant: 'max', cost: 0.25 }],
    0.25,
    { verdict: 'PASS', reason: null },
    'openrouter'
  );
  assert.match(summary, /openrouter\/openai\/gpt-5\.6-luna \[effort=max\]/);
  assert.match(summary, /total cost: \$0\.250000/);
});
