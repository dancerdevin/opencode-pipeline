#!/usr/bin/env node
// plan -> execute -> review pipeline driven over opencode's HTTP API (not the
// `run` CLI subcommand). `run` was found to auto-reject its own `bash: ask`
// permission prompts client-side whenever there's no TTY, even when attached
// to a shared server (`opencode serve`) that a TUI (`opencode attach`) is also
// watching. Sessions created directly via the HTTP API don't have that
// problem: their permission prompts surface in any attached TUI for live
// human approval. Model selection is configuration-driven: the original
// command resolves tiered models against OpenRouter pricing, while the GPT
// command supplies fixed subscription-backed models. All session, approval,
// diff, review, and retry machinery is shared here.
import { execFile, spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { DEFAULT_CONFIG_PATH, PIPELINE_STAGES, loadConfig } from './config.mjs';
import { fetchPricing, resolveTierModel } from './resolve-model.mjs';
import {
  createRunState,
  formatRunStateStatus,
  loadRunState,
  runStatePath,
  saveRunState,
} from './run-state.mjs';

const execFileAsync = promisify(execFile);

const DEFAULT_SERVER_PORT = 4747;
const READINESS_TIMEOUT_MS = 10_000;
const READINESS_POLL_INTERVAL_MS = 300;
const DEFAULT_STAGE_TIMEOUTS_MS = {
  plan: 30 * 60 * 1000,
  execute: 60 * 60 * 1000,
  review: 30 * 60 * 1000,
};
const DEFAULT_STAGE_GRACE_MS = 5 * 60 * 1000;
const DEFAULT_HEARTBEAT_MS = 30 * 1000;
// How often the permission watchdog polls the server for pending asks, and how
// often it re-announces an ask that stays unanswered.
const PERMISSION_POLL_INTERVAL_MS = Number(process.env.PIPELINE_PERMISSION_POLL_MS) || 3_000;
const PERMISSION_REMINDER_INTERVAL_MS = Number(process.env.PIPELINE_PERMISSION_REMINDER_MS) || 30_000;
// How much of the working-tree diff to embed in the review prompt before
// truncating (the reviewer can read the full files for anything cut off).
const REVIEW_DIFF_MAX_CHARS = 100_000;

const CHATGPT_LOGIN_INSTRUCTIONS =
  'This command requires ChatGPT subscription authentication and never falls back to an OpenAI API key, ' +
  'OpenRouter, or another model.\n' +
  'Authenticate and refresh OpenCode with:\n' +
  '  1. Run: opencode auth login\n' +
  '  2. Choose: OpenAI\n' +
  '  3. Choose: ChatGPT Plus/Pro\n' +
  '  4. Run: node setup.mjs\n' +
  '  5. Restart opencode serve, then retry this command.';

const AGENT_BY_STAGE = {
  plan: 'pipeline-plan',
  execute: 'pipeline-execute',
  review: 'pipeline-review',
};

const AGENT_PROMPT_CONTRACTS = {
  'pipeline-plan': ['VERIFICATION_PLAN:', 'PLAN_RESULT: READY', 'PLAN_RESULT: BLOCKED: <reason>'],
  'pipeline-execute': ['VERIFICATION_RESULT:', 'EXECUTE_RESULT: COMPLETE', 'EXECUTE_RESULT: BLOCKED: <reason>'],
  'pipeline-review': [
    'REQUIRED_FIXES:',
    'NOTES:',
    'severity:',
    'evidence:',
    'confidence:',
    'REVIEW_RESULT: PASS',
    'REVIEW_RESULT: FAIL: <short, specific, actionable reason>',
  ],
};

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function resolveStageTimeouts(env = process.env) {
  const globalTimeout = Number.isFinite(Number(env.PIPELINE_STAGE_TIMEOUT_MS)) && Number(env.PIPELINE_STAGE_TIMEOUT_MS) > 0
    ? Number(env.PIPELINE_STAGE_TIMEOUT_MS)
    : null;
  const timeouts = {};
  for (const stage of PIPELINE_STAGES) {
    const variable = `PIPELINE_${stage.toUpperCase()}_TIMEOUT_MS`;
    timeouts[stage] = positiveNumber(env[variable], globalTimeout || DEFAULT_STAGE_TIMEOUTS_MS[stage]);
  }
  return timeouts;
}

function resolveStageGraceMs(env = process.env) {
  return positiveNumber(env.PIPELINE_STAGE_GRACE_MS, DEFAULT_STAGE_GRACE_MS);
}

function resolveHeartbeatMs(env = process.env) {
  return positiveNumber(env.PIPELINE_HEARTBEAT_MS, DEFAULT_HEARTBEAT_MS);
}

function formatDuration(durationMs) {
  if (!Number.isFinite(durationMs)) return 'unknown duration';
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

class StageTimeoutError extends Error {
  constructor({ stage, sessionId, elapsedMs, timeoutMs, graceMs, lastActivityAt, pendingPermissions }) {
    super(
      `[${stage}] timed out after ${formatDuration(elapsedMs)} waiting for session ${sessionId} ` +
        `(limit ${formatDuration(timeoutMs)} plus ${formatDuration(graceMs)} activity grace; ` +
        `last activity ${lastActivityAt || 'unknown'}; pending approvals ${pendingPermissions})`
    );
    this.name = 'StageTimeoutError';
    this.stage = stage;
    this.sessionId = sessionId;
    this.elapsedMs = elapsedMs;
    this.timeoutMs = timeoutMs;
    this.graceMs = graceMs;
    this.lastActivityAt = lastActivityAt;
    this.pendingPermissions = pendingPermissions;
    this.resumable = true;
  }
}

function splitModelId(model) {
  // model is like 'openrouter/anthropic/claude-haiku-4.5'
  const [providerID, ...rest] = model.split('/');
  return { providerID, modelID: rest.join('/') };
}

function extractErrorMessage(error) {
  return error?.data?.message || error?.message || JSON.stringify(error);
}

function subscriptionPreflightError(reasons) {
  const detail = reasons.map((reason) => `  - ${reason}`).join('\n');
  return new Error(`GPT subscription preflight failed:\n${detail}\n\n${CHATGPT_LOGIN_INSTRUCTIONS}`);
}

function openRouterPreflightError(reasons) {
  const detail = reasons.map((reason) => `  - ${reason}`).join('\n');
  return new Error(
    `OpenRouter model preflight failed:\n${detail}\n\n` +
      'Verify OpenRouter authentication, model availability, and configured effort variants, then restart opencode serve and retry.'
  );
}

function costMetadataIssue(cost) {
  if (!cost || typeof cost !== 'object' || Array.isArray(cost)) {
    return 'cost metadata is missing';
  }
  for (const key of ['input', 'output']) {
    if (!Number.isFinite(cost[key])) return `cost.${key} metadata is missing`;
  }

  const pricedFields = new Set(['input', 'output', 'read', 'write']);
  const visit = (value, pathParts) => {
    if (!value || typeof value !== 'object') return null;
    for (const [key, child] of Object.entries(value)) {
      const childPath = [...pathParts, key];
      if (pricedFields.has(key)) {
        if (!Number.isFinite(child)) return `${childPath.join('.')} is not numeric`;
        if (child !== 0) return `${childPath.join('.')} is ${child}, not zero`;
        continue;
      }
      const issue = visit(child, childPath);
      if (issue) return issue;
    }
    return null;
  };
  return visit(cost, ['cost']);
}

// Validates the runtime provider registry instead of trusting an OpenCode
// version number or local credential file. OpenCode exposes API-priced models
// with nonzero cost metadata; ChatGPT OAuth rewrites subscription-backed model
// costs to zero, which lets this command intentionally reject API-key routing.
function validateChatGptSubscriptionProvider(registry, stageModels, stageVariants = {}) {
  const reasons = [];
  if (!registry || typeof registry !== 'object') {
    throw subscriptionPreflightError(['OpenCode returned a malformed provider registry']);
  }
  if (!Array.isArray(registry.connected) || !registry.connected.includes('openai')) {
    reasons.push('OpenAI is not connected through OpenCode');
  }

  const openai = Array.isArray(registry.all) ? registry.all.find((provider) => provider?.id === 'openai') : null;
  if (!openai) {
    reasons.push('the OpenAI provider is missing from OpenCode\'s provider registry');
  }

  for (const stage of PIPELINE_STAGES) {
    const fullModel = stageModels[stage];
    const { providerID, modelID } = splitModelId(fullModel);
    if (providerID !== 'openai') {
      reasons.push(`${stage} model ${fullModel} is not routed through the OpenAI provider`);
      continue;
    }
    const model = openai?.models?.[modelID];
    if (!model) {
      reasons.push(`${fullModel} is not available from the connected OpenAI provider`);
      continue;
    }
    if (model.status && model.status !== 'active') {
      reasons.push(`${fullModel} is not active in the connected OpenAI provider (status: ${model.status})`);
      continue;
    }
    const issue = costMetadataIssue(model.cost);
    if (issue) {
      reasons.push(`${fullModel} does not have zero-valued subscription cost metadata (${issue})`);
    }
    const variant = stageVariants[stage];
    if (variant !== undefined && !model.variants?.[variant]) {
      reasons.push(`${fullModel} does not expose the configured ${stage} variant "${variant}"`);
    }
  }

  if (reasons.length > 0) throw subscriptionPreflightError(reasons);
  return true;
}

function validateOpenRouterProvider(registry, resolvedStageModels) {
  const reasons = [];
  if (!registry || typeof registry !== 'object') {
    throw openRouterPreflightError(['OpenCode returned a malformed provider registry']);
  }
  if (!Array.isArray(registry.connected) || !registry.connected.includes('openrouter')) {
    reasons.push('OpenRouter is not connected through OpenCode');
  }

  const openrouter = Array.isArray(registry.all)
    ? registry.all.find((provider) => provider?.id === 'openrouter')
    : null;
  if (!openrouter) {
    reasons.push('the OpenRouter provider is missing from OpenCode\'s provider registry');
  }

  for (const stage of PIPELINE_STAGES) {
    const resolved = resolvedStageModels?.[stage];
    const fullModel = resolved?.model;
    if (typeof fullModel !== 'string') {
      reasons.push(`${stage} has no resolved OpenRouter model`);
      continue;
    }
    const { providerID, modelID } = splitModelId(fullModel);
    if (providerID !== 'openrouter') {
      reasons.push(`${stage} model ${fullModel} is not routed through the OpenRouter provider`);
      continue;
    }
    const model = openrouter?.models?.[modelID];
    if (!model) {
      reasons.push(`${fullModel} is not available from the connected OpenRouter provider`);
      continue;
    }
    if (model.status && model.status !== 'active') {
      reasons.push(`${fullModel} is not active in the connected OpenRouter provider (status: ${model.status})`);
      continue;
    }
    if (resolved.variant !== undefined && !model.variants?.[resolved.variant]) {
      reasons.push(`${fullModel} does not expose the configured ${stage} variant "${resolved.variant}"`);
    }
  }

  if (reasons.length > 0) throw openRouterPreflightError(reasons);
  return true;
}

async function preflightChatGptSubscription(
  serverUrl,
  dir,
  stageModels,
  stageVariantsOrOptions = {},
  options = {}
) {
  // Preserve the original exported signature where the fourth argument was
  // `{ fetchFn }`, while allowing callers to pass stage variants explicitly.
  let stageVariants = stageVariantsOrOptions;
  if (typeof stageVariantsOrOptions?.fetchFn === 'function' && Object.keys(stageVariantsOrOptions).length === 1) {
    options = stageVariantsOrOptions;
    stageVariants = {};
  }
  const { fetchFn = fetch } = options;
  let res;
  try {
    res = await fetchFn(`${serverUrl}/provider?directory=${encodeURIComponent(dir)}`);
  } catch (error) {
    throw subscriptionPreflightError([`could not query OpenCode's provider registry: ${error.message}`]);
  }
  if (!res.ok) {
    throw subscriptionPreflightError([`OpenCode's provider registry returned HTTP ${res.status}`]);
  }
  let registry;
  try {
    registry = await res.json();
  } catch {
    throw subscriptionPreflightError([`OpenCode's provider registry did not return valid JSON`]);
  }
  validateChatGptSubscriptionProvider(registry, stageModels, stageVariants);
}

async function preflightOpenRouterProvider(
  serverUrl,
  dir,
  resolvedStageModels,
  { fetchFn = fetch } = {}
) {
  let res;
  try {
    res = await fetchFn(`${serverUrl}/provider?directory=${encodeURIComponent(dir)}`);
  } catch (error) {
    throw openRouterPreflightError([`could not query OpenCode's provider registry: ${error.message}`]);
  }
  if (!res.ok) {
    throw openRouterPreflightError([`OpenCode's provider registry returned HTTP ${res.status}`]);
  }
  let registry;
  try {
    registry = await res.json();
  } catch {
    throw openRouterPreflightError(['OpenCode\'s provider registry did not return valid JSON']);
  }
  validateOpenRouterProvider(registry, resolvedStageModels);
}

function pipelineAgentError(reasons) {
  const detail = reasons.map((reason) => `  - ${reason}`).join('\n');
  return new Error(
    `Pipeline server preflight failed:\n${detail}\n\n` +
      'Run `node setup.mjs`, restart `opencode serve`, and retry.'
  );
}

function validatePipelineAgents(agents) {
  if (!Array.isArray(agents)) throw pipelineAgentError(['OpenCode returned a malformed agent list']);
  const reasons = [];
  for (const [name, markers] of Object.entries(AGENT_PROMPT_CONTRACTS)) {
    const agent = agents.find((candidate) => candidate?.name === name);
    if (!agent) {
      reasons.push(`${name} is not loaded`);
      continue;
    }
    for (const marker of markers) {
      if (typeof agent.prompt !== 'string' || !agent.prompt.includes(marker)) {
        reasons.push(`${name} is stale or missing prompt contract ${marker}`);
      }
    }
  }
  if (reasons.length > 0) throw pipelineAgentError(reasons);
  return true;
}

async function preflightExistingPipelineServer(serverUrl, dir, { fetchFn = fetch } = {}) {
  let health;
  try {
    health = await fetchFn(`${serverUrl}/global/health`);
  } catch (error) {
    throw pipelineAgentError([`could not reach ${serverUrl}: ${error.message}`]);
  }
  if (!health.ok) throw pipelineAgentError([`${serverUrl}/global/health returned HTTP ${health.status}`]);

  let response;
  try {
    response = await fetchFn(`${serverUrl}/agent?directory=${encodeURIComponent(dir)}`);
  } catch (error) {
    throw pipelineAgentError([`could not query loaded agents: ${error.message}`]);
  }
  if (!response.ok) throw pipelineAgentError([`OpenCode agent list returned HTTP ${response.status}`]);
  let agents;
  try {
    agents = await response.json();
  } catch {
    throw pipelineAgentError(['OpenCode agent list did not return valid JSON']);
  }
  return validatePipelineAgents(agents);
}

async function resolveStageModels(config, { fetchPricingFn = fetchPricing } = {}) {
  if (config.modelStrategy === 'fixed') {
    return Object.fromEntries(
      PIPELINE_STAGES.map((stage) => [stage, {
        model: config.stageModels[stage],
        ...(config.stageVariants?.[stage] ? { variant: config.stageVariants[stage] } : {}),
      }])
    );
  }

  const pricingMap = await fetchPricingFn();
  return Object.fromEntries(
    PIPELINE_STAGES.map((stage) => {
      const tier = config.stageTiers[stage];
      const variant = config.stageVariants?.[stage];
      const resolved = resolveTierModel(tier, config.tiers, pricingMap, { requiredVariant: variant });
      return [stage, { ...resolved, ...(variant ? { variant } : {}) }];
    })
  );
}

async function resolveStageModelsIfNeeded(config, resolved, { resolveFn = resolveStageModels } = {}) {
  return resolved || resolveFn(config);
}

function formatStageDone(stage, result, billingMode, verdict = null) {
  const usage =
    billingMode === 'chatgpt-subscription'
      ? 'ChatGPT subscription allowance'
      : `cost $${result.cost.toFixed(6)}`;
  const duration = result.durationMs === undefined ? '' : ` in ${formatDuration(result.durationMs)}`;
  return `[${stage}] done${duration} (${usage})${verdict ? ` -> ${verdict}` : ''}`;
}

function formatPipelineSummary(stageLog, totalCost, reviewResult, billingMode) {
  const lines = ['--- Pipeline summary ---'];
  for (const stage of stageLog) {
    const usage =
      billingMode === 'chatgpt-subscription'
        ? 'ChatGPT subscription allowance'
        : `$${stage.cost.toFixed(6)}`;
    const model = stage.variant ? `${stage.model} [effort=${stage.variant}]` : stage.model;
    const duration = stage.durationMs === undefined ? '' : ` ${formatDuration(stage.durationMs)}`;
    lines.push(`  ${stage.stage.padEnd(16)} ${model.padEnd(40)} ${usage}${duration ? ` (${duration})` : ''}`);
  }
  if (billingMode === 'chatgpt-subscription') {
    lines.push('  billing: ChatGPT subscription allowance');
  } else {
    lines.push(`  total cost: $${totalCost.toFixed(6)}`);
  }
  lines.push(`  result: ${reviewResult.verdict}${reviewResult.reason ? ` — ${reviewResult.reason}` : ''}`);
  return lines.join('\n');
}

async function createSession(serverUrl, dir, { fetchFn = fetch } = {}) {
  const res = await fetchFn(`${serverUrl}/session?directory=${encodeURIComponent(dir)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) throw new Error(`session create failed: HTTP ${res.status}`);
  const session = await res.json();
  return session.id;
}

async function selectSessionInTui(serverUrl, sessionId, { fetchFn = fetch } = {}) {
  try {
    await fetchFn(`${serverUrl}/tui/select-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionID: sessionId }),
    });
  } catch {
    // best-effort: fine if no TUI is attached, or the call isn't supported
  }
}

async function showTuiToast(serverUrl, { title, message, variant, duration }, { fetchFn = fetch } = {}) {
  try {
    await fetchFn(`${serverUrl}/tui/show-toast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, message, variant, duration }),
    });
  } catch {
    // best-effort: fine if no TUI is attached, or the call isn't supported
  }
}

// Pending permission asks for one session. The endpoint is scoped by the
// session's project directory: without ?directory= the server falls back to
// its own cwd and returns [] (and reply calls 404) even while asks are
// pending — so the directory is mandatory on every permission call.
async function listPendingPermissions(serverUrl, dir, sessionId, { fetchFn = fetch } = {}) {
  try {
    const res = await fetchFn(`${serverUrl}/permission?directory=${encodeURIComponent(dir)}`);
    if (!res.ok) return [];
    const all = await res.json();
    return Array.isArray(all) ? all.filter((p) => p?.sessionID === sessionId) : [];
  } catch {
    return [];
  }
}

async function sendPrompt(
  serverUrl,
  dir,
  sessionId,
  { agent, model, variant, prompt },
  { fetchFn = fetch } = {}
) {
  const { providerID, modelID } = splitModelId(model);
  const res = await fetchFn(
    `${serverUrl}/session/${sessionId}/prompt_async?directory=${encodeURIComponent(dir)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent,
        model: { providerID, modelID },
        ...(variant ? { variant } : {}),
        parts: [{ type: 'text', text: prompt }],
      }),
    }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`prompt_async failed: HTTP ${res.status} ${body}`);
  }
}

// Opens the /global/event SSE stream and returns an async iterator over the
// parsed events (one JS object per `data:` line). Crucially, this awaits the
// `fetch` so the connection — and thus the server-side subscription — is
// established before it returns; any events the server emits after that point
// (including session.idle) are buffered on the connection and delivered on
// subsequent reads. Callers MUST open the stream before sending the prompt
// that starts a stage, otherwise a stage that finishes faster than the SSE
// handshake could emit session.idle before we're subscribed and we'd hang.
// The returned iterator runs until the passed AbortSignal fires.
async function openGlobalEventStream(serverUrl, signal, { fetchFn = fetch } = {}) {
  const res = await fetchFn(`${serverUrl}/global/event`, { signal });
  if (!res.ok || !res.body) {
    throw new Error(`failed to open event stream: HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  async function* iterate() {
    let buffer = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of chunk.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const jsonStr = line.slice(5).trim();
            if (!jsonStr) continue;
            try {
              yield JSON.parse(jsonStr);
            } catch {
              // malformed line; ignore
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  return iterate();
}

async function waitForSessionIdle(eventStream, sessionId, timeoutOrOptions) {
  const options = typeof timeoutOrOptions === 'number'
    ? { timeoutMs: timeoutOrOptions }
    : (timeoutOrOptions || {});
  const {
    timeoutMs,
    graceMs = DEFAULT_STAGE_GRACE_MS,
    heartbeatMs = DEFAULT_HEARTBEAT_MS,
    stage = 'stage',
    getPendingCount = () => 0,
    onHeartbeat = () => {},
    nowFn = Date.now,
  } = options;
  const startedAt = nowFn();
  let lastActivityAt = startedAt;
  let graceGranted = false;
  let settled = false;
  let timer;
  let heartbeatTimer;

  const cleanup = () => {
    clearTimeout(timer);
    clearTimeout(heartbeatTimer);
  };

  const iterationDone = (async () => {
    for await (const evt of eventStream) {
      const payload = evt?.payload;
      if (!payload || payload.type === 'sync') continue;
      const props = payload.properties;
      if (!props || props.sessionID !== sessionId) continue;
      if (payload.type === 'session.error') {
        throw new Error(`session error: ${extractErrorMessage(props.error)}`);
      }
      if (payload.type === 'session.idle') return;
      lastActivityAt = nowFn();
    }
    throw new Error('global event stream ended before session went idle');
  })();
  // If a timeout wins, the event iterator will be closed by the caller's
  // AbortController. Keep its eventual rejection from becoming unhandled.
  iterationDone.catch(() => {});

  return new Promise((resolve, reject) => {
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };

    iterationDone.then(
      (value) => settle(null, value),
      (error) => settle(error)
    );

    const heartbeat = () => {
      if (settled) return;
      const now = nowFn();
      onHeartbeat({
        stage,
        elapsedMs: now - startedAt,
        lastActivityAt,
        pendingPermissions: getPendingCount(),
      });
      heartbeatTimer = setTimeout(heartbeat, heartbeatMs);
    };

    const checkDeadline = () => {
      if (settled) return;
      const now = nowFn();
      const elapsedMs = now - startedAt;
      const pendingPermissions = getPendingCount();
      if (elapsedMs >= timeoutMs) {
        const recentActivity = now - lastActivityAt <= graceMs;
        if (!graceGranted && (recentActivity || pendingPermissions > 0)) {
          graceGranted = true;
          onHeartbeat({
            stage,
            elapsedMs,
            lastActivityAt,
            pendingPermissions,
            graceGranted: true,
          });
        } else if (!graceGranted || elapsedMs >= timeoutMs + graceMs) {
          settle(new StageTimeoutError({
            stage,
            sessionId,
            elapsedMs,
            timeoutMs,
            graceMs,
            lastActivityAt: new Date(lastActivityAt).toISOString(),
            pendingPermissions,
          }));
          return;
        }
      }
      const nextDelay = Math.max(1, Math.min(heartbeatMs, timeoutMs + (graceGranted ? graceMs : 0) - elapsedMs));
      timer = setTimeout(checkDeadline, nextDelay);
    };

    heartbeatTimer = setTimeout(heartbeat, heartbeatMs);
    timer = setTimeout(checkDeadline, Math.max(1, Math.min(heartbeatMs, timeoutMs)));
  });
}

function permissionReplyCommand(serverUrl, dir, requestId, reply) {
  const url = `${serverUrl}/permission/${requestId}/reply?directory=${encodeURIComponent(dir)}`;
  return `curl -s -X POST '${url}' -H 'Content-Type: application/json' -d '{"reply":"${reply}"}'`;
}

// Polls the server's pending-permission list while a stage runs so an approval
// ask is never silently stranded. Each new ask is announced here with
// copy-paste commands that answer it over the HTTP API — which works with zero
// TUIs attached, and also for asks that fired before a TUI attached (whose
// dialog the TUI may not re-present). Unanswered asks are re-announced every
// PERMISSION_REMINDER_INTERVAL_MS. Note: typing an approval into the TUI's
// prompt box does NOT answer an ask — it queues as chat text; only the TUI
// approval dialog or the reply endpoint resolves it.
function startPermissionWatchdog(serverUrl, sessionId, stageLabel, dir, { onActivity = () => {}, fetchFn = fetch } = {}) {
  const pending = new Map(); // request id -> PermissionRequest
  let stopped = false;
  let ticking = false;
  let lastReminder = 0;

  const describe = (p) => {
    const what = [p.permission, ...(p.patterns || [])].filter(Boolean).join(': ') || 'permission';
    const meta = p.metadata && Object.keys(p.metadata).length > 0 ? ` ${JSON.stringify(p.metadata)}` : '';
    return `${what}${meta}`;
  };

  const announce = (p, isReminder) => {
    console.log(
      `\n*** ${isReminder ? 'REMINDER: still ' : ''}waiting for approval — [${stageLabel}] asked for ${describe(p)} ***\n` +
        `  Answer in the attached TUI's approval dialog, or from any terminal:\n` +
        `    approve once:    ${permissionReplyCommand(serverUrl, dir, p.id, 'once')}\n` +
        `    approve always:  ${permissionReplyCommand(serverUrl, dir, p.id, 'always')}\n` +
        `    reject:          ${permissionReplyCommand(serverUrl, dir, p.id, 'reject')}\n` +
        `  (Typing into the TUI's prompt box will NOT answer this — it queues as chat text.)\n`
    );
  };

  const tick = async () => {
    if (stopped) return;
    const now = Date.now();
    const current = await listPendingPermissions(serverUrl, dir, sessionId, { fetchFn });
    onActivity({ pendingPermissions: current.length, checkedAt: now });
    for (const p of current) {
      if (pending.has(p.id)) continue;
      pending.set(p.id, p);
      announce(p, false);
      lastReminder = now;
      // Nudge the TUI to this session and flash a toast, in case one is attached.
      await selectSessionInTui(serverUrl, sessionId, { fetchFn });
      await showTuiToast(serverUrl, {
        title: 'Approval needed',
        message: describe(p),
        variant: 'warning',
        duration: 15000,
      }, { fetchFn });
    }
    for (const id of [...pending.keys()]) {
      if (current.some((p) => p.id === id)) continue;
      pending.delete(id);
      console.log(`[${stageLabel}] approval ${id} answered; stage continuing`);
    }
    if (pending.size > 0 && now - lastReminder >= PERMISSION_REMINDER_INTERVAL_MS) {
      lastReminder = now;
      for (const p of pending.values()) announce(p, true);
    }
  };

  const timer = setInterval(() => {
    if (stopped || ticking) return;
    ticking = true;
    tick()
      .catch(() => {})
      .finally(() => {
        ticking = false;
      });
  }, PERMISSION_POLL_INTERVAL_MS);
  // Never keep the process alive just for the watchdog.
  timer.unref?.();
  tick().catch(() => {});

  const stop = () => {
    stopped = true;
    clearInterval(timer);
  };
  stop.getPendingCount = () => pending.size;
  return stop;
}

async function getSessionMessages(serverUrl, dir, sessionId, { fetchFn = fetch } = {}) {
  const res = await fetchFn(
    `${serverUrl}/session/${sessionId}/message?directory=${encodeURIComponent(dir)}`
  );
  if (!res.ok) throw new Error(`fetching messages failed: HTTP ${res.status}`);
  return res.json();
}

function hasStageCompletionSentinel(text, stage) {
  if (stage === 'plan') return /(?:^|\n)PLAN_RESULT:\s*(?:READY|BLOCKED)(?::|\s*$)/m.test(text);
  if (stage === 'execute') return /(?:^|\n)EXECUTE_RESULT:\s*(?:COMPLETE|BLOCKED)(?::|\s*$)/m.test(text);
  if (stage === 'review') return /(?:^|\n)REVIEW_RESULT:\s*(?:PASS|FAIL)(?::|\s*$)/m.test(text);
  return false;
}

// A reused execute session contains several user turns. Only return the final
// assistant response produced by this prompt, while charging all assistant
// messages produced during the turn to this stage attempt.
function getStageResult(messages, previousAssistantIds) {
  const assistantMessages = messages.filter(
    (message) => message.info?.role === 'assistant' && !previousAssistantIds.has(message.info.id)
  );
  let cost = 0;
  for (const message of assistantMessages) cost += message.info.cost || 0;

  const finalMessage = assistantMessages.findLast((message) =>
    message.parts?.some((part) => part.type === 'text' && part.text)
  );
  const text = finalMessage?.parts
    .filter((part) => part.type === 'text' && part.text)
    .map((part) => part.text)
    .join('\n') || '';
  if (!text) {
    throw new Error('stage became idle without a final assistant text response');
  }
  return { text, cost };
}

async function runStage({
  serverUrl,
  agent,
  model,
  variant,
  dir,
  prompt,
  stage,
  stageLabel,
  sessionId: existingSessionId,
  resumeOnly = false,
  previousAssistantIds: previousAssistantIdsArg = [],
  env = process.env,
  fetchFn = fetch,
  onSessionReady = async () => {},
  onPromptSent = async () => {},
}) {
  const startedAt = Date.now();
  const sessionId = existingSessionId || await createSession(serverUrl, dir, { fetchFn });
  const before = existingSessionId && !previousAssistantIdsArg.length
    ? await getSessionMessages(serverUrl, dir, sessionId, { fetchFn })
    : [];
  const previousAssistantIds = new Set(
    previousAssistantIdsArg.length > 0
      ? previousAssistantIdsArg
      : before.filter((message) => message.info?.role === 'assistant').map((message) => message.info.id)
  );
  if (!existingSessionId || !resumeOnly) {
    await onSessionReady({ sessionId, previousAssistantIds: [...previousAssistantIds] });
  }

  // A process can die after the remote session reaches idle but before it
  // observes the event. On resume, collect an already-complete sentinel from
  // the message history before subscribing to a new event stream.
  if (resumeOnly) {
    const existingMessages = await getSessionMessages(serverUrl, dir, sessionId, { fetchFn });
    try {
      const existingResult = getStageResult(existingMessages, previousAssistantIds);
      if (hasStageCompletionSentinel(existingResult.text, stage)) {
        return { ...existingResult, sessionId, durationMs: Date.now() - startedAt, resumed: true };
      }
    } catch {
      // The session is still in progress or has not produced a final text
      // response; subscribe below and wait for its terminal event.
    }
  }

  const controller = new AbortController();
  // Subscribe to the event stream BEFORE sending the prompt: awaiting this
  // guarantees the server-side subscription exists before the stage can start
  // and finish, so we can never miss its session.idle event.
  const stream = await openGlobalEventStream(serverUrl, controller.signal, { fetchFn });
  const stopWatchdog = startPermissionWatchdog(serverUrl, sessionId, stageLabel, dir, { fetchFn });
  try {
    await selectSessionInTui(serverUrl, sessionId, { fetchFn });
    if (!resumeOnly) {
      await sendPrompt(serverUrl, dir, sessionId, { agent, model, variant, prompt }, { fetchFn });
      await onPromptSent({ sessionId });
    }
    await waitForSessionIdle(stream, sessionId, {
      stage: stageLabel,
      timeoutMs: resolveStageTimeouts(env)[stage],
      graceMs: resolveStageGraceMs(env),
      heartbeatMs: resolveHeartbeatMs(env),
      getPendingCount: stopWatchdog.getPendingCount,
      onHeartbeat: ({ elapsedMs, lastActivityAt, pendingPermissions, graceGranted }) => {
        if (graceGranted) {
          console.log(
            `[${stageLabel}] active near timeout; granting bounded ${formatDuration(resolveStageGraceMs(env))} grace ` +
              `(last activity ${new Date(lastActivityAt).toISOString()}, pending approvals ${pendingPermissions})`
          );
          return;
        }
        if (elapsedMs >= resolveHeartbeatMs(env)) {
          console.log(
            `[${stageLabel}] alive for ${formatDuration(elapsedMs)} ` +
              `(last activity ${new Date(lastActivityAt).toISOString()}, pending approvals ${pendingPermissions})`
          );
        }
      },
    });
  } finally {
    stopWatchdog();
    controller.abort();
  }
  const messages = await getSessionMessages(serverUrl, dir, sessionId, { fetchFn });
  return { ...getStageResult(messages, previousAssistantIds), sessionId, durationMs: Date.now() - startedAt, resumed: resumeOnly };
}

async function runGit(dir, args) {
  const { stdout } = await execFileAsync('git', ['-C', dir, ...args], { maxBuffer: 32 * 1024 * 1024 });
  return stdout.replace(/\n$/, '');
}

// Pure formatting for the working-tree state block embedded in the review
// prompt. Exported for tests.
function formatWorkingTreeState(status, diff) {
  let body = diff;
  let truncated = '';
  if (body.length > REVIEW_DIFF_MAX_CHARS) {
    body = body.slice(0, REVIEW_DIFF_MAX_CHARS);
    truncated = `\n[diff truncated at ${REVIEW_DIFF_MAX_CHARS} chars — read the affected files in full]`;
  }
  return (
    `$ git status --porcelain\n${status || '(clean)'}\n\n` +
    `$ git diff HEAD\n${body || '(no tracked changes — untracked files appear as ?? above; read them in full)'}${truncated}`
  );
}

// Captures what the execute stage actually changed so the review stage judges
// the diff itself rather than trusting the execute summary. The orchestrator
// runs git itself because review runs with bash: deny and couldn't. git diff
// misses untracked files, so status comes along and the review prompt tells
// the reviewer to read ?? files in full. Best-effort: failures become notes
// inside the block, not pipeline errors (a non-git target dir still works).
async function collectWorkingTreeState(dir) {
  const [status, diff] = await Promise.all([
    runGit(dir, ['status', '--porcelain']).catch((e) => `(git status failed: ${e.message})`),
    runGit(dir, ['diff', 'HEAD']).catch((e) => `(git diff failed: ${e.message})`),
  ]);
  return formatWorkingTreeState(status, diff);
}

function parseReviewResult(text) {
  const matches = [...text.matchAll(/REVIEW_RESULT:\s*(PASS|FAIL)(?::\s*(.*))?/g)];
  if (matches.length === 0) {
    const reason = 'Review agent did not emit a REVIEW_RESULT sentinel line.';
    return { verdict: 'FAIL', reason, feedback: reason };
  }
  const last = matches[matches.length - 1];
  const verdict = last[1];
  const reason = verdict === 'FAIL' ? (last[2] || '(no reason given)').trim() : null;
  let feedback = null;
  if (verdict === 'FAIL') {
    const block = text.match(/(?:^|\n)REQUIRED_FIXES:\s*\n([\s\S]*?)(?=\n(?:NOTES:|REVIEW_RESULT:))/);
    feedback = block?.[1]?.trim() || reason;
  }
  return { verdict, reason, feedback };
}

function parsePhaseResult(text, phase) {
  const contracts = {
    plan: { sentinel: 'PLAN_RESULT', success: 'READY', requiredSection: 'VERIFICATION_PLAN:' },
    execute: { sentinel: 'EXECUTE_RESULT', success: 'COMPLETE', requiredSection: 'VERIFICATION_RESULT:' },
  };
  const contract = contracts[phase];
  if (!contract) throw new Error(`unknown pipeline phase: ${phase}`);

  const finalLine = text.trimEnd().split('\n').at(-1)?.trim() || '';
  const match = finalLine.match(
    new RegExp(`^${contract.sentinel}:\\s*(${contract.success}|BLOCKED)(?::\\s*(.*))?$`)
  );
  if (!match) {
    return {
      status: 'BLOCKED',
      reason: `${phase} agent did not end with a valid ${contract.sentinel} status line.`,
    };
  }
  if (match[1] === 'BLOCKED') {
    return { status: 'BLOCKED', reason: (match[2] || '(no reason given)').trim() };
  }
  if (!text.includes(contract.requiredSection)) {
    return {
      status: 'BLOCKED',
      reason: `${phase} agent did not include the required ${contract.requiredSection} section.`,
    };
  }
  return { status: match[1], reason: null };
}

async function waitForServerReady(url, timeoutMs) {
  const start = Date.now();
  // Any HTTP response (even 404) means the server is up; only a connection
  // failure means "not ready yet". We don't depend on serve's stdout shape.
  while (Date.now() - start < timeoutMs) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, READINESS_POLL_INTERVAL_MS));
    }
  }
  throw new Error(`opencode serve did not become ready at ${url} within ${timeoutMs}ms`);
}

function waitForEnter(promptText) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(promptText, () => {
      rl.close();
      resolve();
    });
  });
}

async function startServer(port) {
  console.log(`Starting opencode serve on port ${port}...`);
  const child = spawn('opencode', ['serve', '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  // Drain output so the child never blocks on a full pipe; we don't parse it.
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  const url = `http://127.0.0.1:${port}`;
  await waitForServerReady(url, READINESS_TIMEOUT_MS);
  console.log(`Server ready at ${url}`);
  return { child, url };
}

function savedStageResult(stageState) {
  if (!stageState?.text) return null;
  return {
    text: stageState.text,
    cost: Number(stageState.cost) || 0,
    durationMs: Number(stageState.durationMs) || 0,
    sessionId: stageState.sessionId,
    resumed: true,
  };
}

function stageAttemptLabel(stage, attempt) {
  return `${stage}${attempt > 0 ? `-retry${attempt}` : ''}`;
}

async function runPipeline({
  task: taskArg,
  targetDirArg,
  configPath,
  command = 'opencode-pipeline',
  externalServerUrlArg,
  preflightComplete = false,
  resolvedStageModelsArg,
  resumeRunId,
  env = process.env,
} = {}) {
  let runState = resumeRunId ? await loadRunState(resumeRunId, { env }) : null;
  const task = runState?.task || taskArg;
  if (!task) throw new Error('A task description is required');
  const dir = path.resolve(runState?.targetDir || targetDirArg || process.cwd());
  const configToLoad = runState?.configPath || configPath;

  if (runState?.status === 'complete') {
    console.log(formatRunStateStatus(runState, { stateDir: env.PIPELINE_STATE_DIR }));
    return runState.finalResult?.verdict === 'PASS' ? 0 : 1;
  }

  const port = env.PIPELINE_SERVER_PORT || DEFAULT_SERVER_PORT;
  const externalServerUrl = runState?.serverUrl || externalServerUrlArg || env.PIPELINE_SERVER_URL;

  let serverHandle = null;
  let serverUrl = externalServerUrl;
  let preserveServerForResume = false;

  if (externalServerUrl) {
    console.log(`Using existing server at ${serverUrl} (PIPELINE_SERVER_URL set; not spawning or tearing down)`);
  } else {
    serverHandle = await startServer(port);
    serverUrl = serverHandle.url;
  }

  const cleanup = () => {
    if (serverHandle) serverHandle.child.kill();
  };
  const onSigint = () => {
    const finish = async () => {
      if (runState && runState.status === 'running') {
        preserveServerForResume = true;
        runState.status = 'paused';
        runState.pauseReason = 'interrupted by SIGINT';
        await saveRunState(runState, { env }).catch(() => {});
      }
      if (!preserveServerForResume) cleanup();
      process.exit(130);
    };
    finish().catch(() => process.exit(130));
  };
  process.on('SIGINT', onSigint);

  let exitCode = 0;
  try {
    const config = await loadConfig(configToLoad);
    let resolved = runState?.resolvedStageModels || resolvedStageModelsArg;
    const modelsWerePreResolved = Boolean(resolved);
    const mustPreflight = !preflightComplete || Boolean(runState);
    if (mustPreflight) {
      console.log('Verifying pipeline agents with OpenCode...');
      await preflightExistingPipelineServer(serverUrl, dir);
      console.log('Pipeline agents verified.\n');
    }
    if (config.billingMode === 'chatgpt-subscription') {
      resolved = await resolveStageModelsIfNeeded(config, resolved);
      if (mustPreflight) {
        console.log('Verifying ChatGPT subscription routing with OpenCode...');
        await preflightChatGptSubscription(serverUrl, dir, config.stageModels, config.stageVariants);
        console.log('ChatGPT subscription routing verified.\n');
      }
    }

    console.log(`\nAttach a TUI in another terminal:\n  opencode attach ${serverUrl}\n`);
    console.log(
      'Only the execute stage can prompt for bash approval (plan/review run read-only, deny bash+edit, and never prompt).'
    );
    console.log(
      'Each stage runs in its own session; the pipeline switches the attached TUI to that session automatically.'
    );
    console.log(
      'Any approval ask is also announced below with copy-paste commands to answer it from any terminal,\n' +
        'so a missing or late-attached TUI can no longer strand a stage.\n'
    );
    if (!externalServerUrl) await waitForEnter('Press Enter once the TUI is attached... ');

    console.log(`\nPipeline target dir: ${dir}`);
    console.log(`Task: ${task}\n`);

    if (config.modelStrategy === 'tiered') {
      console.log(
        modelsWerePreResolved
          ? 'Using models resolved against live OpenRouter pricing during issue preflight...'
          : 'Resolving models against live OpenRouter pricing...'
      );
      resolved = await resolveStageModelsIfNeeded(config, resolved);
      if (mustPreflight) {
        console.log('Verifying OpenRouter model routing with OpenCode...');
        await preflightOpenRouterProvider(serverUrl, dir, resolved);
        console.log('OpenRouter model routing verified.\n');
      }
      for (const stage of PIPELINE_STAGES) {
        const tier = config.stageTiers[stage];
        const variant = resolved[stage].variant ? `, effort=${resolved[stage].variant}` : '';
        console.log(
          `  ${stage} (tier=${tier}): ${resolved[stage].model}${variant} ` +
            `(prompt $${resolved[stage].price.prompt}/tok, completion $${resolved[stage].price.completion}/tok)`
        );
      }
    } else {
      console.log('Using fixed ChatGPT subscription models:');
      for (const stage of PIPELINE_STAGES) {
        const variant = resolved[stage].variant ? `, effort=${resolved[stage].variant}` : '';
        console.log(`  ${stage}: ${resolved[stage].model}${variant} (ChatGPT subscription allowance)`);
      }
    }
    console.log();

    if (!runState) {
      const branch = await runGit(dir, ['branch', '--show-current']).catch(() => null);
      runState = createRunState({
        command,
        task,
        targetDir: dir,
        branch: branch || null,
        serverUrl,
        configPath: configToLoad,
        billingMode: config.billingMode,
        resolvedStageModels: resolved,
      });
      await saveRunState(runState, { env });
      console.log(`Pipeline run ID: ${runState.runId}`);
      console.log(`Pipeline state: ${runStatePath(runState.runId, { env })}`);
    } else {
      const branch = await runGit(dir, ['branch', '--show-current']).catch(() => null);
      if (runState.branch && branch !== runState.branch) {
        throw new Error(`resume target is on branch ${branch || '(detached)'}, expected ${runState.branch}`);
      }
      runState.serverUrl = serverUrl;
      runState.status = 'running';
      delete runState.pauseReason;
      await saveRunState(runState, { env });
      console.log(`Resuming pipeline run ${runState.runId} at ${runState.currentStage || 'next stage'}.`);
      console.log(`Pipeline state: ${runStatePath(runState.runId, { env })}`);
    }

    const totalCostFromState = Number(runState.totalCost) || 0;
    let totalCost = totalCostFromState;
    let stageLog = Array.isArray(runState.stageLog) ? [...runState.stageLog] : [];

    const checkpointStage = async ({ stage, label, attempt, prompt, sessionId, previousAssistantIds, status = 'starting' }) => {
      runState.currentStage = stage;
      runState.status = 'running';
      runState.stages[stage] = {
        ...(runState.stages[stage] || {}),
        label,
        attempt,
        status,
        sessionId: sessionId || runState.stages[stage]?.sessionId || null,
        prompt,
        previousAssistantIds: previousAssistantIds || runState.stages[stage]?.previousAssistantIds || [],
        promptSent: Boolean(runState.stages[stage]?.promptSent),
        startedAt: runState.stages[stage]?.startedAt || new Date().toISOString(),
      };
      await saveRunState(runState, { env });
    };

    const stagePromptWasSent = async (record) => {
      if (!record?.sessionId || !record.prompt) return false;
      const messages = await getSessionMessages(serverUrl, dir, record.sessionId);
      return messages.some((message) =>
        message.info?.role === 'user' &&
        message.parts?.some((part) => part.type === 'text' && part.text === record.prompt)
      );
    };

    const completeStage = async ({ stage, label, result, extra = {} }) => {
      const record = runState.stages[stage] || {};
      runState.stages[stage] = {
        ...record,
        ...extra,
        label,
        status: 'complete',
        text: result.text,
        cost: result.cost,
        durationMs: result.durationMs,
        sessionId: result.sessionId,
        completedAt: new Date().toISOString(),
        promptSent: true,
      };
      const entry = {
        stage: label,
        model: resolved[stage].model,
        variant: resolved[stage].variant,
        cost: result.cost,
        durationMs: result.durationMs,
      };
      stageLog = [...stageLog.filter((item) => item.stage !== label), entry];
      totalCost = stageLog.reduce((sum, item) => sum + (Number(item.cost) || 0), 0);
      runState.stageLog = stageLog;
      runState.totalCost = totalCost;
      await saveRunState(runState, { env });
    };

    const planRecord = runState.stages.plan || {};
    let planResult = savedStageResult(planRecord);
    if (!planResult) {
      const planPrompt = `Task: ${task}`;
      console.log(`[plan] running ${resolved.plan.model}${resolved.plan.variant ? `, effort=${resolved.plan.variant}` : ''}...`);
      const planResume = Boolean(resumeRunId && planRecord.sessionId && planRecord.promptSent);
      await checkpointStage({
        stage: 'plan',
        label: 'plan',
        attempt: 0,
        prompt: planPrompt,
        sessionId: planRecord.sessionId,
        previousAssistantIds: planRecord.previousAssistantIds,
        status: planResume ? 'running' : 'starting',
      });
      if (planResume === false && resumeRunId && planRecord.sessionId && !planRecord.promptSent && await stagePromptWasSent(planRecord)) {
        planResult = await runStage({
          serverUrl,
          agent: AGENT_BY_STAGE.plan,
          model: resolved.plan.model,
          variant: resolved.plan.variant,
          dir,
          prompt: planPrompt,
          stage: 'plan',
          stageLabel: 'plan',
          sessionId: planRecord.sessionId,
          resumeOnly: true,
          previousAssistantIds: planRecord.previousAssistantIds,
          env,
        });
      } else {
        planResult = await runStage({
          serverUrl,
          agent: AGENT_BY_STAGE.plan,
          model: resolved.plan.model,
          variant: resolved.plan.variant,
          dir,
          prompt: planPrompt,
          stage: 'plan',
          stageLabel: 'plan',
          sessionId: planRecord.sessionId,
          resumeOnly: planResume,
          previousAssistantIds: planRecord.previousAssistantIds,
          env,
          onSessionReady: async ({ sessionId, previousAssistantIds }) => {
            await checkpointStage({ stage: 'plan', label: 'plan', attempt: 0, prompt: planPrompt, sessionId, previousAssistantIds, status: 'starting' });
          },
          onPromptSent: async () => {
            runState.stages.plan.promptSent = true;
            runState.stages.plan.status = 'running';
            await saveRunState(runState, { env });
          },
        });
      }
      await completeStage({ stage: 'plan', label: 'plan', result: planResult });
      console.log(`${formatStageDone('plan', planResult, config.billingMode)}\n`);
    } else {
      console.log(`[plan] already complete in ${formatDuration(planResult.durationMs)}.\n`);
    }
    const planStatus = parsePhaseResult(planResult.text, 'plan');
    if (planStatus.status !== 'READY') {
      runState.status = 'failed';
      runState.finalResult = { verdict: 'BLOCKED', reason: planStatus.reason };
      await saveRunState(runState, { env });
      throw new Error(`[plan] blocked: ${planStatus.reason}`);
    }

    let executeResult = savedStageResult(runState.stages.execute);
    let executeSessionId = runState.stages.execute?.sessionId;
    let attempt = Number(runState.stages.execute?.attempt) || 0;
    let reviewResult = runState.stages.review?.verdict
      ? {
          verdict: runState.stages.review.verdict,
          reason: runState.stages.review.reason,
          feedback: runState.stages.review.feedback,
          text: runState.stages.review.text,
        }
      : null;

    while (true) {
      const executeLabel = stageAttemptLabel('execute', attempt);
      if (!executeResult) {
        const executePrompt = attempt === 0
          ? `Task: ${task}\n\nPlan:\n${planResult.text}`
          : `Review rejected the previous attempt. Address every item below, then re-run the relevant verification and end with the required EXECUTE_RESULT status line.\n\nREQUIRED_FIXES:\n${runState.stages.review.feedback}`;
        const executeRecord = runState.stages.execute || {};
        const executeResume = Boolean(resumeRunId && executeRecord.sessionId && executeRecord.promptSent && executeRecord.attempt === attempt);
        await checkpointStage({
          stage: 'execute',
          label: executeLabel,
          attempt,
          prompt: executePrompt,
          sessionId: executeSessionId,
          previousAssistantIds: executeRecord.previousAssistantIds,
          status: executeResume ? 'running' : 'starting',
        });
        const promptAlreadySent = Boolean(
          resumeRunId && executeRecord.sessionId && !executeRecord.promptSent && await stagePromptWasSent(executeRecord)
        );
        console.log(`[execute] running ${resolved.execute.model}${resolved.execute.variant ? `, effort=${resolved.execute.variant}` : ''}${attempt > 0 ? ` (retry ${attempt})` : ''}...`);
        executeResult = await runStage({
          serverUrl,
          agent: AGENT_BY_STAGE.execute,
          model: resolved.execute.model,
          variant: resolved.execute.variant,
          dir,
          prompt: executePrompt,
          stage: 'execute',
          stageLabel: executeLabel,
          sessionId: executeSessionId,
          resumeOnly: executeResume || promptAlreadySent,
          previousAssistantIds: executeRecord.previousAssistantIds,
          env,
          onSessionReady: async ({ sessionId, previousAssistantIds }) => {
            executeSessionId = sessionId;
            await checkpointStage({ stage: 'execute', label: executeLabel, attempt, prompt: executePrompt, sessionId, previousAssistantIds, status: 'starting' });
          },
          onPromptSent: async () => {
            runState.stages.execute.promptSent = true;
            runState.stages.execute.status = 'running';
            await saveRunState(runState, { env });
          },
        });
        executeSessionId = executeResult.sessionId;
        await completeStage({ stage: 'execute', label: executeLabel, result: executeResult });
        console.log(`${formatStageDone('execute', executeResult, config.billingMode)}\n`);
        const executeStatus = parsePhaseResult(executeResult.text, 'execute');
        if (executeStatus.status !== 'COMPLETE') {
          runState.status = 'failed';
          runState.finalResult = { verdict: 'BLOCKED', reason: executeStatus.reason };
          await saveRunState(runState, { env });
          throw new Error(`[execute] blocked: ${executeStatus.reason}`);
        }
      } else {
        console.log(`[execute] already complete${attempt > 0 ? ` (retry ${attempt})` : ''} in ${formatDuration(executeResult.durationMs)}.\n`);
      }

      const reviewLabel = stageAttemptLabel('review', attempt);
      const reviewRecord = runState.stages.review || {};
      if (!reviewResult || reviewRecord.status !== 'complete' || reviewRecord.attempt !== attempt) {
        const reviewTreeState = await collectWorkingTreeState(dir);
        const reviewPrompt =
          `Task: ${task}\n\nPlan:\n${planResult.text}\n\nExecute stage summary:\n${executeResult.text}\n\n` +
          `Working-tree state after execution (captured by the orchestrator):\n${reviewTreeState}`;
        const reviewResume = Boolean(resumeRunId && reviewRecord.sessionId && reviewRecord.promptSent && reviewRecord.attempt === attempt);
        await checkpointStage({
          stage: 'review',
          label: reviewLabel,
          attempt,
          prompt: reviewPrompt,
          sessionId: reviewRecord.sessionId,
          previousAssistantIds: reviewRecord.previousAssistantIds,
          status: reviewResume ? 'running' : 'starting',
        });
        const promptAlreadySent = Boolean(
          resumeRunId && reviewRecord.sessionId && !reviewRecord.promptSent && await stagePromptWasSent(reviewRecord)
        );
        console.log(`[review] running ${resolved.review.model}${resolved.review.variant ? `, effort=${resolved.review.variant}` : ''}${attempt > 0 ? ` (retry ${attempt})` : ''}...`);
        const rawReview = await runStage({
          serverUrl,
          agent: AGENT_BY_STAGE.review,
          model: resolved.review.model,
          variant: resolved.review.variant,
          dir,
          prompt: reviewPrompt,
          stage: 'review',
          stageLabel: reviewLabel,
          sessionId: reviewRecord.sessionId,
          resumeOnly: reviewResume || promptAlreadySent,
          previousAssistantIds: reviewRecord.previousAssistantIds,
          env,
          onSessionReady: async ({ sessionId, previousAssistantIds }) => {
            await checkpointStage({ stage: 'review', label: reviewLabel, attempt, prompt: reviewPrompt, sessionId, previousAssistantIds, status: 'starting' });
          },
          onPromptSent: async () => {
            runState.stages.review.promptSent = true;
            runState.stages.review.status = 'running';
            await saveRunState(runState, { env });
          },
        });
        reviewResult = parseReviewResult(rawReview.text);
        await completeStage({
          stage: 'review',
          label: reviewLabel,
          result: rawReview,
          extra: {
            verdict: reviewResult.verdict,
            reason: reviewResult.reason,
            feedback: reviewResult.feedback,
          },
        });
        console.log(`${formatStageDone('review', rawReview, config.billingMode, reviewResult.verdict)}\n`);
        console.log(`--- review findings ---\n${rawReview.text.trim()}\n-----------------------\n`);
      } else {
        console.log(`[review] already complete${attempt > 0 ? ` (retry ${attempt})` : ''}: ${reviewResult.verdict}.\n`);
      }

      if (reviewResult.verdict === 'PASS') break;
      if (attempt >= config.maxRetries) break;

      attempt += 1;
      executeResult = null;
      executeSessionId = runState.stages.execute.sessionId;
      runState.stages.execute = {
        ...runState.stages.execute,
        status: 'pending',
        attempt,
        prompt: null,
        text: null,
        cost: 0,
        durationMs: 0,
        promptSent: false,
      };
      runState.stages.review = {
        ...runState.stages.review,
        status: 'pending',
        attempt,
        sessionId: null,
        prompt: null,
        text: null,
        cost: 0,
        durationMs: 0,
        promptSent: false,
      };
      runState.currentStage = 'execute';
      await saveRunState(runState, { env });
    }

    console.log(formatPipelineSummary(stageLog, totalCost, reviewResult, config.billingMode));
    exitCode = reviewResult.verdict === 'PASS' ? 0 : 1;
    runState.status = 'complete';
    runState.finalResult = { verdict: reviewResult.verdict, reason: reviewResult.reason };
    await saveRunState(runState, { env });
  } catch (error) {
    if (runState && error instanceof StageTimeoutError) {
      preserveServerForResume = true;
      runState.status = 'paused';
      runState.pauseReason = error.message;
      runState.currentStage = error.stage;
      await saveRunState(runState, { env }).catch(() => {});
      error.message += `\nRun paused; inspect it with: ${runState.command || 'opencode-pipeline'} --status ${runState.runId}` +
        `\nResume with: ${runState.command || 'opencode-pipeline'} --resume ${runState.runId}`;
    } else if (runState && runState.status === 'running' && runState.currentStage) {
      runState.status = 'failed';
      runState.finalResult = { verdict: 'FAIL', reason: error.message };
      await saveRunState(runState, { env }).catch(() => {});
    }
    throw error;
  } finally {
    process.removeListener('SIGINT', onSigint);
    if (!preserveServerForResume) cleanup();
  }

  return exitCode;
}

async function runPipelineFromCli({
  configPath,
  command = 'opencode-pipeline',
  args = process.argv.slice(2),
  env = process.env,
  runPipelineFn = runPipeline,
  runIssuePipelineFn,
} = {}) {
  const launcher = await import('./issue-launcher.mjs');
  const parsed = launcher.parsePipelineCliArgs(args);
  if (parsed.mode === 'help') {
    console.log(launcher.issueUsage(command));
    console.log('\nIssue mode requires an existing OpenCode server and GitHub CLI authentication.');
    return 0;
  }
  if (parsed.mode === 'error') {
    console.error(`${parsed.message}\n\n${launcher.issueUsage(command)}`);
    return 1;
  }
  if (parsed.mode === 'status') {
    try {
      const state = await loadRunState(parsed.runId, { env });
      console.log(formatRunStateStatus(state, { stateDir: env.PIPELINE_STATE_DIR }));
      return 0;
    } catch (error) {
      console.error(`Pipeline status failed: ${error.message}`);
      return 1;
    }
  }
  if (parsed.mode === 'resume') {
    return runPipelineFn({ resumeRunId: parsed.runId, configPath, command, env });
  }
  if (parsed.mode === 'issue') {
    const port = env.PIPELINE_SERVER_PORT || DEFAULT_SERVER_PORT;
    const serverUrl = env.PIPELINE_SERVER_URL || `http://127.0.0.1:${port}`;
    const issueConfigPath = configPath || env.PIPELINE_CONFIG || DEFAULT_CONFIG_PATH;
    const launch = runIssuePipelineFn || launcher.runIssuePipeline;
    return launch({ ...parsed, command, serverUrl, configPath: issueConfigPath });
  }
  return runPipelineFn({ task: parsed.task, targetDirArg: parsed.targetDirArg, configPath, command, env });
}

// True when this file is the entry point, including via a bin symlink (npm
// installs one; realpath resolves it) or from a path containing spaces
// (pathToFileURL percent-encodes the way import.meta.url does).
const isMain = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isMain) {
  runPipelineFromCli()
    .then((exitCode) => process.exit(exitCode))
    .catch((err) => {
      console.error(`Pipeline failed: ${err.message}`);
      process.exit(1);
    });
}

// Exported for tests (and potential reuse); running this file directly still
// executes the pipeline via the isMain guard above.
export {
  startPermissionWatchdog,
  listPendingPermissions,
  permissionReplyCommand,
  resolveStageTimeouts,
  resolveStageGraceMs,
  resolveHeartbeatMs,
  waitForSessionIdle,
  StageTimeoutError,
  parseReviewResult,
  parsePhaseResult,
  getStageResult,
  runStage,
  formatWorkingTreeState,
  collectWorkingTreeState,
  validateChatGptSubscriptionProvider,
  preflightChatGptSubscription,
  validateOpenRouterProvider,
  preflightOpenRouterProvider,
  validatePipelineAgents,
  preflightExistingPipelineServer,
  resolveStageModels,
  resolveStageModelsIfNeeded,
  sendPrompt,
  formatStageDone,
  formatPipelineSummary,
  runPipeline,
  runPipelineFromCli,
};
