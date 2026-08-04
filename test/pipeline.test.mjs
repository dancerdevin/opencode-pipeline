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
  resolveStageModels,
  formatStageDone,
  formatPipelineSummary,
} from '../run-pipeline.mjs';
import { GPT_CONFIG_PATH, loadConfig } from '../config.mjs';
import { resolveTierModel } from '../resolve-model.mjs';

const execFileAsync = promisify(execFile);

const GPT_STAGE_MODELS = {
  plan: 'openai/gpt-5.6-terra',
  execute: 'openai/gpt-5.6-luna',
  review: 'openai/gpt-5.6-sol',
};

function subscriptionRegistry({ connected = ['openai'], missing = [], costs = {} } = {}) {
  const models = {};
  for (const fullModel of Object.values(GPT_STAGE_MODELS)) {
    const modelID = fullModel.slice('openai/'.length);
    if (missing.includes(modelID)) continue;
    models[modelID] = {
      id: modelID,
      providerID: 'openai',
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

test('permissionReplyCommand: includes directory-scoped URL, request id, and reply', () => {
  const cmd = permissionReplyCommand('http://127.0.0.1:4747', '/tmp/my dir', 'req123', 'once');
  assert.match(cmd, /permission\/req123\/reply/);
  assert.match(cmd, /directory=%2Ftmp%2Fmy%20dir/);
  assert.match(cmd, /"reply":"once"/);
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

test('loadConfig: bundled GPT config pins Terra, Luna, and Sol', async () => {
  const config = await loadConfig(GPT_CONFIG_PATH);
  assert.equal(config.modelStrategy, 'fixed');
  assert.equal(config.billingMode, 'chatgpt-subscription');
  assert.deepEqual(config.stageModels, GPT_STAGE_MODELS);
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

test('GPT preflight: rejects disconnected OpenAI', () => {
  assert.throws(
    () => validateChatGptSubscriptionProvider(subscriptionRegistry({ connected: ['openrouter'] }), GPT_STAGE_MODELS),
    /OpenAI is not connected[\s\S]*opencode auth login/
  );
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
        subscriptionRegistry({ costs: { 'gpt-5.6-terra': undefined } }),
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
