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
import { PIPELINE_STAGES, loadConfig } from './config.mjs';
import { fetchPricing, resolveTierModel } from './resolve-model.mjs';

const execFileAsync = promisify(execFile);

const DEFAULT_SERVER_PORT = 4747;
const READINESS_TIMEOUT_MS = 10_000;
const READINESS_POLL_INTERVAL_MS = 300;
const STAGE_TIMEOUT_MS = Number(process.env.PIPELINE_STAGE_TIMEOUT_MS) || 30 * 60 * 1000;
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
function validateChatGptSubscriptionProvider(registry, stageModels) {
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
  }

  if (reasons.length > 0) throw subscriptionPreflightError(reasons);
  return true;
}

async function preflightChatGptSubscription(serverUrl, dir, stageModels) {
  let res;
  try {
    res = await fetch(`${serverUrl}/provider?directory=${encodeURIComponent(dir)}`);
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
  validateChatGptSubscriptionProvider(registry, stageModels);
}

async function resolveStageModels(config, { fetchPricingFn = fetchPricing } = {}) {
  if (config.modelStrategy === 'fixed') {
    return Object.fromEntries(
      PIPELINE_STAGES.map((stage) => [stage, { model: config.stageModels[stage] }])
    );
  }

  const pricingMap = await fetchPricingFn();
  return Object.fromEntries(
    PIPELINE_STAGES.map((stage) => {
      const tier = config.stageTiers[stage];
      return [stage, resolveTierModel(tier, config.tiers, pricingMap)];
    })
  );
}

function formatStageDone(stage, result, billingMode, verdict = null) {
  const usage =
    billingMode === 'chatgpt-subscription'
      ? 'ChatGPT subscription allowance'
      : `cost $${result.cost.toFixed(6)}`;
  return `[${stage}] done (${usage})${verdict ? ` -> ${verdict}` : ''}`;
}

function formatPipelineSummary(stageLog, totalCost, reviewResult, billingMode) {
  const lines = ['--- Pipeline summary ---'];
  for (const stage of stageLog) {
    const usage =
      billingMode === 'chatgpt-subscription'
        ? 'ChatGPT subscription allowance'
        : `$${stage.cost.toFixed(6)}`;
    lines.push(`  ${stage.stage.padEnd(16)} ${stage.model.padEnd(40)} ${usage}`);
  }
  if (billingMode === 'chatgpt-subscription') {
    lines.push('  billing: ChatGPT subscription allowance');
  } else {
    lines.push(`  total cost: $${totalCost.toFixed(6)}`);
  }
  lines.push(`  result: ${reviewResult.verdict}${reviewResult.reason ? ` — ${reviewResult.reason}` : ''}`);
  return lines.join('\n');
}

async function createSession(serverUrl, dir) {
  const res = await fetch(`${serverUrl}/session?directory=${encodeURIComponent(dir)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) throw new Error(`session create failed: HTTP ${res.status}`);
  const session = await res.json();
  return session.id;
}

async function selectSessionInTui(serverUrl, sessionId) {
  try {
    await fetch(`${serverUrl}/tui/select-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionID: sessionId }),
    });
  } catch {
    // best-effort: fine if no TUI is attached, or the call isn't supported
  }
}

async function showTuiToast(serverUrl, { title, message, variant, duration }) {
  try {
    await fetch(`${serverUrl}/tui/show-toast`, {
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
async function listPendingPermissions(serverUrl, dir, sessionId) {
  try {
    const res = await fetch(`${serverUrl}/permission?directory=${encodeURIComponent(dir)}`);
    if (!res.ok) return [];
    const all = await res.json();
    return Array.isArray(all) ? all.filter((p) => p?.sessionID === sessionId) : [];
  } catch {
    return [];
  }
}

async function sendPrompt(serverUrl, dir, sessionId, { agent, model, prompt }) {
  const { providerID, modelID } = splitModelId(model);
  const res = await fetch(
    `${serverUrl}/session/${sessionId}/prompt_async?directory=${encodeURIComponent(dir)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent,
        model: { providerID, modelID },
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
async function openGlobalEventStream(serverUrl, signal) {
  const res = await fetch(`${serverUrl}/global/event`, { signal });
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

async function waitForSessionIdle(eventStream, sessionId, timeoutMs) {
  const iterationDone = (async () => {
    for await (const evt of eventStream) {
      const payload = evt?.payload;
      if (!payload || payload.type === 'sync') continue;
      const props = payload.properties;
      if (!props || props.sessionID !== sessionId) continue;
      if (payload.type === 'session.error') {
        throw new Error(`session error: ${extractErrorMessage(props.error)}`);
      }
      if (payload.type === 'session.idle') {
        return;
      }
    }
    throw new Error('global event stream ended before session went idle');
  })();
  // Attach a no-op catch so that if the timeout branch wins the race below,
  // this promise settling later doesn't surface as an unhandled rejection.
  iterationDone.catch(() => {});

  return Promise.race([
    iterationDone,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`stage timed out waiting for session ${sessionId} to go idle after ${timeoutMs}ms`)),
        timeoutMs
      )
    ),
  ]);
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
function startPermissionWatchdog(serverUrl, sessionId, stageLabel, dir) {
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
    const current = await listPendingPermissions(serverUrl, dir, sessionId);
    for (const p of current) {
      if (pending.has(p.id)) continue;
      pending.set(p.id, p);
      announce(p, false);
      lastReminder = now;
      // Nudge the TUI to this session and flash a toast, in case one is attached.
      await selectSessionInTui(serverUrl, sessionId);
      await showTuiToast(serverUrl, {
        title: 'Approval needed',
        message: describe(p),
        variant: 'warning',
        duration: 15000,
      });
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

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

async function getSessionMessages(serverUrl, dir, sessionId) {
  const res = await fetch(
    `${serverUrl}/session/${sessionId}/message?directory=${encodeURIComponent(dir)}`
  );
  if (!res.ok) throw new Error(`fetching messages failed: HTTP ${res.status}`);
  return res.json();
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

async function runStage({ serverUrl, agent, model, dir, prompt, stageLabel, sessionId: existingSessionId }) {
  const sessionId = existingSessionId || await createSession(serverUrl, dir);
  const before = existingSessionId ? await getSessionMessages(serverUrl, dir, sessionId) : [];
  const previousAssistantIds = new Set(
    before.filter((message) => message.info?.role === 'assistant').map((message) => message.info.id)
  );
  const controller = new AbortController();
  // Subscribe to the event stream BEFORE sending the prompt: awaiting this
  // guarantees the server-side subscription exists before the stage can start
  // and finish, so we can never miss its session.idle event.
  const stream = await openGlobalEventStream(serverUrl, controller.signal);
  const stopWatchdog = startPermissionWatchdog(serverUrl, sessionId, stageLabel, dir);
  try {
    await selectSessionInTui(serverUrl, sessionId);
    await sendPrompt(serverUrl, dir, sessionId, { agent, model, prompt });
    await waitForSessionIdle(stream, sessionId, STAGE_TIMEOUT_MS);
  } finally {
    stopWatchdog();
    controller.abort();
  }
  const messages = await getSessionMessages(serverUrl, dir, sessionId);
  return { ...getStageResult(messages, previousAssistantIds), sessionId };
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
    plan: { sentinel: 'PLAN_RESULT', success: 'READY' },
    execute: { sentinel: 'EXECUTE_RESULT', success: 'COMPLETE' },
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

async function runPipeline({ task, targetDirArg, configPath } = {}) {
  if (!task) throw new Error('A task description is required');
  const dir = path.resolve(targetDirArg || process.cwd());

  const port = process.env.PIPELINE_SERVER_PORT || DEFAULT_SERVER_PORT;
  const externalServerUrl = process.env.PIPELINE_SERVER_URL;

  let serverHandle = null;
  let serverUrl = externalServerUrl;

  if (externalServerUrl) {
    console.log(`Using existing server at ${serverUrl} (PIPELINE_SERVER_URL set; not spawning or tearing down)`);
  } else {
    serverHandle = await startServer(port);
    serverUrl = serverHandle.url;
  }

  const cleanup = () => {
    if (serverHandle) {
      serverHandle.child.kill();
    }
  };
  const onSigint = () => {
    cleanup();
    process.exit(130);
  };
  process.on('SIGINT', onSigint);

  let exitCode = 0;
  try {
    const config = await loadConfig(configPath);
    let resolved;
    if (config.billingMode === 'chatgpt-subscription') {
      resolved = await resolveStageModels(config);
      console.log('Verifying ChatGPT subscription routing with OpenCode...');
      await preflightChatGptSubscription(serverUrl, dir, config.stageModels);
      console.log('ChatGPT subscription routing verified.\n');
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
    if (!externalServerUrl) {
      await waitForEnter('Press Enter once the TUI is attached... ');
    }

    console.log(`\nPipeline target dir: ${dir}`);
    console.log(`Task: ${task}\n`);

    if (config.modelStrategy === 'tiered') {
      console.log('Resolving models against live OpenRouter pricing...');
      resolved = await resolveStageModels(config);
      for (const stage of PIPELINE_STAGES) {
        const tier = config.stageTiers[stage];
        console.log(
          `  ${stage} (tier=${tier}): ${resolved[stage].model} ` +
            `(prompt $${resolved[stage].price.prompt}/tok, completion $${resolved[stage].price.completion}/tok)`
        );
      }
    } else {
      console.log('Using fixed ChatGPT subscription models:');
      for (const stage of PIPELINE_STAGES) {
        console.log(`  ${stage}: ${resolved[stage].model} (ChatGPT subscription allowance)`);
      }
    }
    console.log();

    let totalCost = 0;
    const stageLog = [];

    console.log(`[plan] running ${resolved.plan.model}...`);
    const planResult = await runStage({
      serverUrl,
      agent: AGENT_BY_STAGE.plan,
      model: resolved.plan.model,
      dir,
      prompt: `Task: ${task}`,
      stageLabel: 'plan',
    });
    totalCost += planResult.cost;
    stageLog.push({ stage: 'plan', model: resolved.plan.model, cost: planResult.cost });
    console.log(`${formatStageDone('plan', planResult, config.billingMode)}\n`);
    const planStatus = parsePhaseResult(planResult.text, 'plan');
    if (planStatus.status !== 'READY') {
      throw new Error(`[plan] blocked: ${planStatus.reason}`);
    }

    let executePrompt = `Task: ${task}\n\nPlan:\n${planResult.text}`;
    let executeResult;
    let executeSessionId;
    let reviewResult;
    let attempt = 0;

    while (true) {
      console.log(`[execute] running ${resolved.execute.model}${attempt > 0 ? ` (retry ${attempt})` : ''}...`);
      executeResult = await runStage({
        serverUrl,
        agent: AGENT_BY_STAGE.execute,
        model: resolved.execute.model,
        dir,
        prompt: executePrompt,
        stageLabel: `execute${attempt > 0 ? `-retry${attempt}` : ''}`,
        sessionId: executeSessionId,
      });
      executeSessionId = executeResult.sessionId;
      totalCost += executeResult.cost;
      stageLog.push({ stage: `execute${attempt > 0 ? `-retry${attempt}` : ''}`, model: resolved.execute.model, cost: executeResult.cost });
      console.log(`${formatStageDone('execute', executeResult, config.billingMode)}\n`);
      const executeStatus = parsePhaseResult(executeResult.text, 'execute');
      if (executeStatus.status !== 'COMPLETE') {
        throw new Error(`[execute] blocked: ${executeStatus.reason}`);
      }

      console.log(`[review] running ${resolved.review.model}${attempt > 0 ? ` (retry ${attempt})` : ''}...`);
      const treeState = await collectWorkingTreeState(dir);
      const reviewPrompt =
        `Task: ${task}\n\nPlan:\n${planResult.text}\n\nExecute stage summary:\n${executeResult.text}\n\n` +
        `Working-tree state after execution (captured by the orchestrator):\n${treeState}`;
      const rawReview = await runStage({
        serverUrl,
        agent: AGENT_BY_STAGE.review,
        model: resolved.review.model,
        dir,
        prompt: reviewPrompt,
        stageLabel: `review${attempt > 0 ? `-retry${attempt}` : ''}`,
      });
      totalCost += rawReview.cost;
      stageLog.push({ stage: `review${attempt > 0 ? `-retry${attempt}` : ''}`, model: resolved.review.model, cost: rawReview.cost });
      reviewResult = parseReviewResult(rawReview.text);
      console.log(`${formatStageDone('review', rawReview, config.billingMode, reviewResult.verdict)}\n`);
      // The verdict used to be all the operator saw; print the reviewer's full
      // findings so notes that don't rise to FAIL still reach a human.
      console.log(`--- review findings ---\n${rawReview.text.trim()}\n-----------------------\n`);

      if (reviewResult.verdict === 'PASS') break;
      if (attempt >= config.maxRetries) break;

      attempt += 1;
      executePrompt =
        `Review rejected the previous attempt. Address every item below, then re-run the relevant ` +
        `verification and end with the required EXECUTE_RESULT status line.\n\n` +
        `REQUIRED_FIXES:\n${reviewResult.feedback}`;
    }

    console.log(formatPipelineSummary(stageLog, totalCost, reviewResult, config.billingMode));

    exitCode = reviewResult.verdict === 'PASS' ? 0 : 1;
  } finally {
    process.removeListener('SIGINT', onSigint);
    cleanup();
  }

  return exitCode;
}

async function runPipelineFromCli({ configPath, usage = 'node run-pipeline.mjs' } = {}) {
  const [, , task, targetDirArg] = process.argv;
  if (!task) {
    console.error(`Usage: ${usage} "<task description>" [target-dir]`);
    return 1;
  }
  return runPipeline({ task, targetDirArg, configPath });
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
  parseReviewResult,
  parsePhaseResult,
  getStageResult,
  formatWorkingTreeState,
  collectWorkingTreeState,
  validateChatGptSubscriptionProvider,
  preflightChatGptSubscription,
  resolveStageModels,
  formatStageDone,
  formatPipelineSummary,
  runPipeline,
  runPipelineFromCli,
};
