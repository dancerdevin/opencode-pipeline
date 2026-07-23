#!/usr/bin/env node
// plan -> execute -> review pipeline driven over opencode's HTTP API (not the
// `run` CLI subcommand). `run` was found to auto-reject its own `bash: ask`
// permission prompts client-side whenever there's no TTY, even when attached
// to a shared server (`opencode serve`) that a TUI (`opencode attach`) is also
// watching. Sessions created directly via the HTTP API don't have that
// problem: their permission prompts surface in any attached TUI for live
// human approval. Per-stage model tier is resolved against live OpenRouter
// pricing (see resolve-model.mjs); tiers, stage→tier mapping, and the retry
// cap live in pipeline.config.json.
import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fetchPricing, resolveTierModel, loadConfig } from './resolve-model.mjs';

const DEFAULT_SERVER_PORT = 4747;
const READINESS_TIMEOUT_MS = 10_000;
const READINESS_POLL_INTERVAL_MS = 300;
const STAGE_TIMEOUT_MS = Number(process.env.PIPELINE_STAGE_TIMEOUT_MS) || 30 * 60 * 1000;
// How often the permission watchdog polls the server for pending asks, and how
// often it re-announces an ask that stays unanswered.
const PERMISSION_POLL_INTERVAL_MS = Number(process.env.PIPELINE_PERMISSION_POLL_MS) || 3_000;
const PERMISSION_REMINDER_INTERVAL_MS = Number(process.env.PIPELINE_PERMISSION_REMINDER_MS) || 30_000;

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

async function sendPrompt(serverUrl, sessionId, { agent, model, prompt }) {
  const { providerID, modelID } = splitModelId(model);
  const res = await fetch(`${serverUrl}/session/${sessionId}/prompt_async`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agent,
      model: { providerID, modelID },
      parts: [{ type: 'text', text: prompt }],
    }),
  });
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

async function getStageResult(serverUrl, sessionId) {
  const res = await fetch(`${serverUrl}/session/${sessionId}/message`);
  if (!res.ok) throw new Error(`fetching messages failed: HTTP ${res.status}`);
  const messages = await res.json();
  let text = '';
  let cost = 0;
  for (const m of messages) {
    if (m.info.role !== 'assistant') continue;
    cost += m.info.cost || 0;
    for (const part of m.parts) {
      if (part.type === 'text' && part.text) text += part.text;
    }
  }
  return { text, cost };
}

async function runStage({ serverUrl, agent, model, dir, prompt, stageLabel }) {
  const sessionId = await createSession(serverUrl, dir);
  const controller = new AbortController();
  // Subscribe to the event stream BEFORE sending the prompt: awaiting this
  // guarantees the server-side subscription exists before the stage can start
  // and finish, so we can never miss its session.idle event.
  const stream = await openGlobalEventStream(serverUrl, controller.signal);
  const stopWatchdog = startPermissionWatchdog(serverUrl, sessionId, stageLabel, dir);
  try {
    await selectSessionInTui(serverUrl, sessionId);
    await sendPrompt(serverUrl, sessionId, { agent, model, prompt });
    await waitForSessionIdle(stream, sessionId, STAGE_TIMEOUT_MS);
  } finally {
    stopWatchdog();
    controller.abort();
  }
  return getStageResult(serverUrl, sessionId);
}

function parseReviewResult(text) {
  const matches = [...text.matchAll(/REVIEW_RESULT:\s*(PASS|FAIL)(?::\s*(.*))?/g)];
  if (matches.length === 0) {
    return { verdict: 'FAIL', reason: 'Review agent did not emit a REVIEW_RESULT sentinel line.' };
  }
  const last = matches[matches.length - 1];
  const verdict = last[1];
  const reason = verdict === 'FAIL' ? (last[2] || '(no reason given)').trim() : null;
  return { verdict, reason };
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

async function main() {
  const [, , task, targetDirArg] = process.argv;
  if (!task) {
    console.error('Usage: node run-pipeline.mjs "<task description>" [target-dir]');
    process.exit(1);
  }
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

    console.log('Resolving models against live OpenRouter pricing...');
    const config = await loadConfig();
    const pricingMap = await fetchPricing();
    const resolved = {};
    for (const stage of ['plan', 'execute', 'review']) {
      const tier = config.stageTiers[stage];
      resolved[stage] = resolveTierModel(tier, config.tiers, pricingMap);
      console.log(
        `  ${stage} (tier=${tier}): ${resolved[stage].model} ` +
          `(prompt $${resolved[stage].price.prompt}/tok, completion $${resolved[stage].price.completion}/tok)`
      );
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
    console.log(`[plan] done (cost $${planResult.cost.toFixed(6)})\n`);

    let executePrompt = `Task: ${task}\n\nPlan:\n${planResult.text}`;
    let executeResult;
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
      });
      totalCost += executeResult.cost;
      stageLog.push({ stage: `execute${attempt > 0 ? `-retry${attempt}` : ''}`, model: resolved.execute.model, cost: executeResult.cost });
      console.log(`[execute] done (cost $${executeResult.cost.toFixed(6)})\n`);

      console.log(`[review] running ${resolved.review.model}${attempt > 0 ? ` (retry ${attempt})` : ''}...`);
      const reviewPrompt =
        `Task: ${task}\n\nPlan:\n${planResult.text}\n\nExecute stage summary:\n${executeResult.text}`;
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
      console.log(`[review] done (cost $${rawReview.cost.toFixed(6)}) -> ${reviewResult.verdict}\n`);

      if (reviewResult.verdict === 'PASS') break;
      if (attempt >= config.maxRetries) break;

      attempt += 1;
      executePrompt =
        `Task: ${task}\n\nPlan:\n${planResult.text}\n\n` +
        `Your previous attempt was rejected by review for this reason:\n${reviewResult.reason}\n\n` +
        `Fix that specific problem without regressing other parts of the plan you already completed.`;
    }

    console.log('--- Pipeline summary ---');
    for (const s of stageLog) {
      console.log(`  ${s.stage.padEnd(16)} ${s.model.padEnd(40)} $${s.cost.toFixed(6)}`);
    }
    console.log(`  total cost: $${totalCost.toFixed(6)}`);
    console.log(`  result: ${reviewResult.verdict}${reviewResult.reason ? ` — ${reviewResult.reason}` : ''}`);

    exitCode = reviewResult.verdict === 'PASS' ? 0 : 1;
  } finally {
    process.removeListener('SIGINT', onSigint);
    cleanup();
  }

  process.exit(exitCode);
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(`Pipeline failed: ${err.message}`);
    process.exit(1);
  });
}

// Exported for tests (and potential reuse); running this file directly still
// executes the pipeline via the isMain guard above.
export { startPermissionWatchdog, listPendingPermissions, permissionReplyCommand, parseReviewResult };
