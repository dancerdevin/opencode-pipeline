// Turns a GitHub issue into a deterministic pipeline run. This module owns
// issue intake and safe branch preparation; the shared pipeline remains the
// only owner of model sessions, permissions, retries, and review.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { loadConfig } from './config.mjs';
import {
  preflightChatGptSubscription,
  preflightExistingPipelineServer,
  resolveStageModels,
  runPipeline,
} from './run-pipeline.mjs';

const execFileAsync = promisify(execFile);
const ISSUE_FIELDS = 'number,title,body,url,state,labels,comments';
const REPO_FIELDS = 'nameWithOwner,url,defaultBranchRef';
const MAX_BRANCH_LENGTH = 80;

function issueUsage(command = 'opencode-pipeline') {
  return [
    `Usage: ${command} "<task description>" [target-dir]`,
    `       ${command} --issue <number-or-url> [target-dir]`,
  ].join('\n');
}

function parsePipelineCliArgs(args) {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) return { mode: 'help' };
  if (args[0] === '--issue') {
    if (args.length < 2 || args.length > 3 || !isIssueReference(args[1])) {
      return { mode: 'error', message: '--issue requires an issue number or GitHub issue URL' };
    }
    return { mode: 'issue', issueRef: args[1], targetDirArg: args[2] };
  }
  if (args.length < 1 || args.length > 2 || args[0].startsWith('-')) {
    return { mode: 'error', message: 'a task description is required' };
  }
  return { mode: 'task', task: args[0], targetDirArg: args[1] };
}

function isIssueReference(value) {
  if (/^[1-9]\d*$/.test(value || '')) return true;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) &&
      /^\/[^/]+\/[^/]+\/issues\/[1-9]\d*\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

function issueBranchName(number, title) {
  const prefix = `issue-${number}`;
  const maxSlugLength = MAX_BRANCH_LENGTH - prefix.length - 1;
  const slug = String(title || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxSlugLength)
    .replace(/-+$/g, '');
  return slug ? `${prefix}-${slug}` : prefix;
}

function formatIssueTask(issue, repository) {
  const labels = Array.isArray(issue.labels)
    ? issue.labels.map((label) => typeof label === 'string' ? label : label?.name).filter(Boolean)
    : [];
  const lines = [
    `Implement GitHub issue #${issue.number}: ${issue.title}`,
    '',
    `Repository: ${repository.nameWithOwner}`,
    `Issue: ${issue.url}`,
    `Labels: ${labels.length > 0 ? labels.join(', ') : '(none)'}`,
    '',
    'Issue body:',
    issue.body?.trim() || '(empty)',
  ];
  const comments = Array.isArray(issue.comments)
    ? [...issue.comments].sort((left, right) =>
        String(left.createdAt || '').localeCompare(String(right.createdAt || ''))
      )
    : [];
  lines.push('', 'Discussion:');
  if (comments.length === 0) {
    lines.push('(no comments)');
  } else {
    for (const comment of comments) {
      const author = comment.author?.login ? `@${comment.author.login}` : '(unknown author)';
      const timestamp = comment.createdAt ? ` at ${comment.createdAt}` : '';
      lines.push('', `Comment by ${author}${timestamp}:`, comment.body?.trim() || '(empty)');
    }
  }
  return lines.join('\n');
}

function parseJsonOutput(stdout, subject) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`${subject} returned malformed JSON: ${error.message}`);
  }
}

async function defaultExec(command, args, options) {
  return execFileAsync(command, args, { ...options, maxBuffer: 16 * 1024 * 1024 });
}

async function commandText(execFn, command, args, cwd, subject) {
  try {
    const { stdout } = await execFn(command, args, { cwd });
    return String(stdout).replace(/\n$/, '');
  } catch (error) {
    const detail = String(error.stderr || error.message || '').trim();
    throw new Error(`${subject} failed${detail ? `: ${detail}` : ''}`);
  }
}

function validateIssueForRepository(issue, repository) {
  if (!issue || !Number.isInteger(issue.number) || !issue.title || !issue.url) {
    throw new Error('GitHub returned incomplete issue metadata');
  }
  if (issue.state !== 'OPEN') {
    throw new Error(`issue #${issue.number} is ${String(issue.state || 'not open').toLowerCase()}; issue mode only runs open issues`);
  }
  let issueRepo;
  try {
    issueRepo = new URL(issue.url).pathname.split('/').filter(Boolean).slice(0, 2).join('/');
  } catch {
    throw new Error('GitHub returned an invalid issue URL');
  }
  if (issueRepo.toLowerCase() !== repository.nameWithOwner.toLowerCase()) {
    throw new Error(`issue belongs to ${issueRepo}, but target directory is ${repository.nameWithOwner}`);
  }
}

async function inspectIssueRun(issueRef, targetDirArg, { execFn = defaultExec } = {}) {
  const requestedDir = path.resolve(targetDirArg || process.cwd());
  const root = await commandText(execFn, 'git', ['rev-parse', '--show-toplevel'], requestedDir, 'finding repository root');
  const status = await commandText(execFn, 'git', ['status', '--porcelain'], root, 'checking working tree');
  if (status) throw new Error('target repository has uncommitted changes; issue mode requires a clean working tree');

  const branch = await commandText(execFn, 'git', ['branch', '--show-current'], root, 'checking current branch');
  if (!branch) throw new Error('target repository is in detached HEAD state');
  await commandText(execFn, 'git', ['remote', 'get-url', 'origin'], root, 'checking origin remote');

  const repository = parseJsonOutput(
    await commandText(execFn, 'gh', ['repo', 'view', '--json', REPO_FIELDS], root, 'reading GitHub repository'),
    'gh repo view'
  );
  if (!repository?.nameWithOwner || !repository?.url || !repository?.defaultBranchRef?.name) {
    throw new Error('GitHub returned incomplete repository metadata');
  }
  const issue = parseJsonOutput(
    await commandText(
      execFn,
      'gh',
      ['issue', 'view', issueRef, '--repo', repository.nameWithOwner, '--json', ISSUE_FIELDS],
      root,
      'reading GitHub issue'
    ),
    'gh issue view'
  );
  validateIssueForRepository(issue, repository);

  return {
    root,
    branch,
    repository,
    issue,
    task: formatIssueTask(issue, repository),
    issueBranch: issueBranchName(issue.number, issue.title),
  };
}

async function prepareIssueBranch(context, { execFn = defaultExec } = {}) {
  const defaultBranch = context.repository.defaultBranchRef.name;
  if (context.branch !== defaultBranch) {
    return { branch: context.branch, created: false };
  }

  await commandText(
    execFn,
    'git',
    ['fetch', 'origin', defaultBranch],
    context.root,
    `fetching origin/${defaultBranch}`
  );
  const localTip = await commandText(
    execFn,
    'git',
    ['rev-parse', `refs/heads/${defaultBranch}`],
    context.root,
    `reading local ${defaultBranch}`
  );
  const remoteTip = await commandText(
    execFn,
    'git',
    ['rev-parse', `refs/remotes/origin/${defaultBranch}`],
    context.root,
    `reading origin/${defaultBranch}`
  );
  if (localTip !== remoteTip) {
    throw new Error(
      `local ${defaultBranch} does not match origin/${defaultBranch}; synchronize it before running issue mode`
    );
  }
  const existing = await commandText(
    execFn,
    'git',
    ['branch', '--list', context.issueBranch],
    context.root,
    `checking branch ${context.issueBranch}`
  );
  if (existing.trim()) {
    throw new Error(
      `branch ${context.issueBranch} already exists; inspect and select it explicitly before rerunning`
    );
  }
  await commandText(
    execFn,
    'git',
    ['switch', '-c', context.issueBranch],
    context.root,
    `creating branch ${context.issueBranch}`
  );
  return { branch: context.issueBranch, created: true };
}

async function runIssuePipeline(
  { issueRef, targetDirArg, serverUrl, configPath },
  {
    execFn = defaultExec,
    fetchFn = fetch,
    loadConfigFn = loadConfig,
    preflightServerFn = preflightExistingPipelineServer,
    preflightSubscriptionFn = preflightChatGptSubscription,
    resolveStageModelsFn = resolveStageModels,
    runPipelineFn = runPipeline,
  } = {}
) {
  const context = await inspectIssueRun(issueRef, targetDirArg, { execFn });
  const config = await loadConfigFn(configPath);
  await preflightServerFn(serverUrl, context.root, { fetchFn });
  if (config.billingMode === 'chatgpt-subscription') {
    await preflightSubscriptionFn(
      serverUrl,
      context.root,
      config.stageModels,
      config.stageVariants,
      { fetchFn }
    );
  }
  const resolvedStageModels = await resolveStageModelsFn(config);
  const branch = await prepareIssueBranch(context, { execFn });

  console.log(`GitHub issue: ${context.issue.url}`);
  console.log(`Target repository: ${context.repository.nameWithOwner}`);
  console.log(`${branch.created ? 'Created' : 'Using'} branch: ${branch.branch}`);
  console.log('Issue context loaded (title, body, labels, and comments).\n');

  return runPipelineFn({
    task: context.task,
    targetDirArg: context.root,
    configPath,
    externalServerUrlArg: serverUrl,
    preflightComplete: true,
    resolvedStageModelsArg: resolvedStageModels,
  });
}

export {
  formatIssueTask,
  inspectIssueRun,
  isIssueReference,
  issueBranchName,
  issueUsage,
  parsePipelineCliArgs,
  prepareIssueBranch,
  runIssuePipeline,
  validateIssueForRepository,
};
