// Durable, private run manifests let a supervising process recover from a
// timeout without re-prompting an OpenCode session or mutating the target
// repository. State lives outside the checkout so the core pipeline remains
// git-neutral.
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const RUN_STATE_VERSION = 1;
export const DEFAULT_STATE_DIR = path.join(os.tmpdir(), 'opencode-pipeline-runs');

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;

function stateDirFromOptions({ env = process.env, stateDir } = {}) {
  return path.resolve(stateDir || env.PIPELINE_STATE_DIR || DEFAULT_STATE_DIR);
}

function requireRunId(runId) {
  if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) {
    throw new Error(`invalid pipeline run ID "${runId}"`);
  }
  return runId;
}

export function runStatePath(runId, options = {}) {
  const safeRunId = requireRunId(runId);
  return path.join(stateDirFromOptions(options), `${safeRunId}.json`);
}

function assertStateShape(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('pipeline run state must be a JSON object');
  }
  if (state.version !== RUN_STATE_VERSION) {
    throw new Error(`unsupported pipeline run state version ${state.version}`);
  }
  requireRunId(state.runId);
  if (typeof state.targetDir !== 'string' || !state.targetDir) {
    throw new Error('pipeline run state is missing targetDir');
  }
  if (typeof state.status !== 'string' || !state.status) {
    throw new Error('pipeline run state is missing status');
  }
  if (!state.stages || typeof state.stages !== 'object' || Array.isArray(state.stages)) {
    throw new Error('pipeline run state is missing stages');
  }
  return state;
}

async function writeAtomic(state, options = {}) {
  const destination = runStatePath(state.runId, options);
  const directory = path.dirname(destination);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    await rename(temporary, destination);
    await chmod(destination, 0o600);
  } catch (error) {
    // The temporary file is intentionally left alone if cleanup itself would
    // obscure the original failure; it is harmless inside the private state
    // directory and can be removed by the next maintenance pass.
    throw error;
  }
  return destination;
}

export function createRunState({
  command = 'opencode-pipeline',
  task,
  targetDir,
  branch = null,
  serverUrl = null,
  configPath = null,
  billingMode = null,
  resolvedStageModels = null,
  now = new Date().toISOString(),
} = {}) {
  if (typeof task !== 'string' || !task) throw new Error('pipeline run state requires a task');
  if (typeof targetDir !== 'string' || !targetDir) throw new Error('pipeline run state requires targetDir');
  const runId = randomUUID();
  return {
    version: RUN_STATE_VERSION,
    runId,
    command,
    task,
    targetDir,
    branch,
    serverUrl,
    configPath,
    billingMode,
    resolvedStageModels,
    status: 'running',
    currentStage: null,
    createdAt: now,
    updatedAt: now,
    stages: {
      plan: { status: 'pending', attempt: 0 },
      execute: { status: 'pending', attempt: 0 },
      review: { status: 'pending', attempt: 0 },
    },
    stageLog: [],
    totalCost: 0,
    finalResult: null,
  };
}

export async function saveRunState(state, options = {}) {
  assertStateShape(state);
  const next = { ...state, updatedAt: new Date().toISOString() };
  await writeAtomic(next, options);
  Object.assign(state, next);
  return state;
}

export async function loadRunState(runId, options = {}) {
  const source = runStatePath(runId, options);
  let raw;
  try {
    raw = await readFile(source, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`pipeline run state not found for ${runId}: ${source}`);
    }
    throw new Error(`could not read pipeline run state ${source}: ${error.message}`);
  }
  let state;
  try {
    state = JSON.parse(raw);
  } catch (error) {
    throw new Error(`pipeline run state ${source} is not valid JSON: ${error.message}`);
  }
  try {
    return assertStateShape(state);
  } catch (error) {
    throw new Error(`pipeline run state ${source} is invalid: ${error.message}`);
  }
}

export function formatRunStateStatus(state, { stateDir } = {}) {
  const current = state.currentStage || 'none';
  const stage = current !== 'none' ? state.stages[current] : null;
  const command = state.command || 'opencode-pipeline';
  const lines = [
    `Pipeline run ${state.runId}`,
    `  status: ${state.status}`,
    `  target: ${state.targetDir}`,
    `  branch: ${state.branch || '(not recorded)'}`,
    `  stage: ${current}${stage?.status ? ` (${stage.status})` : ''}`,
    `  updated: ${state.updatedAt}`,
  ];
  if (state.serverUrl) lines.push(`  server: ${state.serverUrl}`);
  if (state.status === 'paused' || state.status === 'running') {
    lines.push(`  resume: ${command} --resume ${state.runId}`);
  }
  if (state.finalResult?.verdict) lines.push(`  result: ${state.finalResult.verdict}`);
  lines.push(`  state: ${runStatePath(state.runId, { stateDir })}`);
  return lines.join('\n');
}

export { assertStateShape };
