# AGENTS.md — opencode-pipeline

Guidance for coding agents working in this repo, and for agents **supervising a
pipeline run** (launching it, watching progress, answering permission asks,
steering stuck stages, shipping the result). [README.md](README.md) is the
canonical user-facing doc; this file is the operator/maintainer cheat sheet.

## What this is

A cost-aware **plan → execute → review** pipeline over OpenCode + OpenRouter.
Each stage is a separate OpenCode session with its own model tier; the cheapest
model per tier is resolved against OpenRouter's *live* pricing at runtime. The
execute stage's `bash` calls surface in a human-attached TUI for live approval.

Node 20+, **zero npm dependencies** (stdlib only). Keep it that way unless a
dependency clearly earns its place.

## Layout

- `run-pipeline.mjs` — orchestrator + entry point (also published as the
  `opencode-pipeline` bin). Talks to `opencode serve` over HTTP, never the CLI.
- `resolve-model.mjs` — cheapest-per-tier resolver (`node resolve-model.mjs <tier>`
  prints what would be picked right now).
- `setup.mjs` — installs/uninstalls the three `pipeline-*` agents as markdown
  files under `~/.config/opencode/agents/` (honors `XDG_CONFIG_HOME`).
- `pipeline.config.json` — tier lists, stage→tier mapping, `maxRetries`.
- `prompts/` — stage system prompts, embedded into the installed agents.
- `test/pipeline.test.mjs` — `node:test` suite.

## Develop & test

```bash
node --test                 # full suite (also: npm test)
node resolve-model.mjs smart   # sanity-check tier resolution against live pricing
```

After editing `prompts/`: re-run `node setup.mjs` **and restart any running
`opencode serve`** — agents are loaded at server startup.

## Invariants — do not break these when editing

- **Review sentinel contract.** `prompts/review.txt` owns the
  `REVIEW_RESULT: PASS` / `REVIEW_RESULT: FAIL: <reason>` format. The
  orchestrator parses it with a regex and takes the **last** match; a missing
  sentinel counts as FAIL. Edit the prompt's wording around it carefully.
- **Agent names.** `run-pipeline.mjs` maps stages to agents named exactly
  `pipeline-plan`, `pipeline-execute`, `pipeline-review` (`AGENT_BY_STAGE`).
  `setup.mjs`, the prompts, and any inline server config must agree.
- **Subscribe before prompting.** Each stage must establish its `/global/event`
  SSE subscription (awaited) *before* sending the prompt, or a fast stage's
  `session.idle` can be missed and the pipeline hangs. Keep that ordering.
- **Permission calls are directory-scoped.** Every `/permission` call (list and
  reply) needs `?directory=<project-dir>`; without it the list reads empty and
  replies 404 (the server falls back to its own cwd).
- **HTTP API, not the `run` CLI.** Sessions created via the API surface their
  permission prompts in any attached TUI; `opencode run` auto-rejects its own
  `bash: ask` prompts when it has no TTY.
- **setup.mjs symmetry.** Install never clobbers an unmarked same-named file
  (backs it up); `--uninstall` removes exactly what it installed (marker
  comment) and restores backups.

## Supervising a pipeline run (monitoring-agent playbook)

### Preflight

1. Server up: `curl http://127.0.0.1:<port>/global/health`.
2. Agents present on that server:
   `curl "http://127.0.0.1:<port>/agent?directory=<target-dir>"` — must list
   `pipeline-plan/-execute/-review`. They can come from `setup.mjs` *or* an
   inline `agent` block in the server's `opencode.json(c)`; either way the
   server must have been (re)started after they were defined.
3. Target repo on a **clean feature branch**. The execute agent edits the
   working tree in place; the pipeline never branches, commits, pushes, or
   opens PRs — that is the supervisor's job before and after the run.

### Launch & watch

```bash
PIPELINE_SERVER_URL=http://127.0.0.1:<port> \
  nohup node run-pipeline.mjs "<task>" <target-dir> > /tmp/pipeline-run.log 2>&1 &
```

With `PIPELINE_SERVER_URL` set, the script attaches to the existing server and
does not spawn/tear one down (and skips the "press Enter" pause). Run it in the
background and poll the log; stages routinely take minutes, and the default
per-stage timeout is 30 min (`PIPELINE_STAGE_TIMEOUT_MS`) to allow for slow
human approvals. Exit code is 0 on PASS, 1 on FAIL.

Only the **execute** stage can prompt for approval (plan/review deny bash+edit
and never prompt). A list of read-only commands (`ls`, `grep`, `git diff`, …)
is pre-approved; note that **compound commands joined with `;` or `|` don't
match those patterns** and fall through to "ask" even when every part is
read-only — approving them is safe.

### Answering permission asks over the API

The pipeline prints every pending ask with copy-paste curl commands (and
re-prints every 30 s until answered). To check/answer programmatically:

```bash
# list pending (directory param is mandatory)
curl "http://127.0.0.1:<port>/permission?directory=<url-encoded-target-dir>"
# answer one: reply is "once" | "always" | "reject"
curl -X POST "http://127.0.0.1:<port>/permission/<request-id>/reply?directory=<dir>" \
  -H 'Content-Type: application/json' -d '{"reply":"once"}'
```

An API reply resolves the actual pending request regardless of what any TUI
shows — useful when the human's TUI attached late or they're away. Approve the
commands the task told execute to run (tests, lint, build); reject anything
unexpected — a rejection is fed back to the agent as feedback, not a crash.
Never "answer" via the TUI's prompt box: typed text queues as chat.

### Steering a stuck or confused stage

Each stage is a fresh session, but you can queue a user message into the
*current* stage session; it is processed before the session goes idle, so the
pipeline incorporates it:

```bash
# find the active session (most recently updated for that directory)
curl "http://127.0.0.1:<port>/session?directory=<url-encoded-target-dir>"
# nudge it
curl -X POST "http://127.0.0.1:<port>/session/<session-id>/prompt_async?directory=<dir>" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"<steering hint>"}]}'
```

Proven use case: the execute agent hunting for a test runner that isn't on
`PATH` (e.g. a project venv) — tell it the exact interpreter/command once
instead of approving an endless series of `find /` probes. Peek at a session's
recent activity via `GET /session/<id>/message?directory=<dir>`.

### After the run

- PASS/FAIL plus a per-stage cost table print at the end; FAIL retries appear
  as `execute-retryN` / `review-retryN` rows, capped by `maxRetries`.
- A pipeline PASS is a strong signal, **not** a substitute for review: read the
  diff yourself, re-run the project's gates yourself, then commit/push/PR if
  that is part of your mandate. Fetch issue/task context up front
  (e.g. `gh issue view`) so the task string names exact files, limits, and
  verification commands — precise tasks produce dramatically better runs.
- Costs are real OpenRouter spend; the summary is the receipt.

## Style

Plain Node stdlib ESM, no build step, no formatter config — match the existing
hand-rolled style (2-space indent, small commented helpers, header comment on
each file explaining the *why*). Keep orchestrator logic unit-testable
(`parseReviewResult`, config loading, permission helpers are exported for
`test/`).
