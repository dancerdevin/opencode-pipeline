# opencode-pipeline

A **plan → execute → review** pipeline over [OpenCode](https://opencode.ai),
with a human (you) approving shell commands live. It has two public commands:

- `opencode-pipeline` keeps the original cost-aware OpenRouter workflow. Each
  stage uses a model tier, and the cheapest configured model in that tier is
  selected from OpenRouter's live pricing.
- `opencode-gpt-pipeline` uses a ChatGPT Plus/Pro subscription with fixed GPT
  models: Terra for plan, Luna for execute, and Sol for review. It never queries
  OpenRouter pricing and never falls back to an API key or another model.

Both commands support `--issue` to fetch an open GitHub issue and prepare a
feature branch before entering their normal model route.

Both commands use the same OpenCode sessions, prompts, permission handling,
diff-aware review, and retry loop. The execute stage's `bash` calls surface in
an attached OpenCode TUI for you to approve or reject as they happen.

- **plan** — reads the repo (read-only) and writes an ordered implementation
  plan.
- **execute** — carries out the plan: edits files and runs
  commands. **`bash` commands pause for approval**, except pre-approved
  read-only inspection (`ls`, `grep`, `git diff`, …) and local verification
  tools (`pytest`, `ruff`, `npx tsc`, `npm test`, …); installs, network calls,
  and git mutations always ask.
- **review** — verifies the work against the actual
  diff: the orchestrator captures `git status` + `git diff HEAD` into the
  review prompt (review itself is read-only, no shell). Its full findings print
  to the log, and it emits `REVIEW_RESULT: PASS` or `REVIEW_RESULT: FAIL:
  <reason>`. Plan and execute only hand off after explicit completion
  sentinels. On FAIL, review sends a bounded `REQUIRED_FIXES` packet back to
  the same execute session, preserving implementation context across up to
  `maxRetries` retries.

The pipeline exits `0` on PASS and `1` on FAIL. OpenRouter runs print a
per-stage dollar-cost receipt; GPT runs report the stage/model and `ChatGPT
subscription allowance` without dollar costs.

## Why not just `openrouter/auto`?

OpenRouter's [Auto router](https://openrouter.ai/docs/features/model-routing) picks a
model **per prompt**, opaquely. This pipeline picks **per stage, deterministically**:
you curate the tier lists in `pipeline.config.json`, the cheapest listed model that
OpenRouter currently prices wins, and the choice is printed before anything runs.
Different stages get different quality floors — cheap for execution, your strongest
model for review — which per-prompt routing can't express.

## What it does and does not do

**It does:** plan, edit files in a directory you point it at, run commands (with your
approval), self-review, and retry. It works entirely inside one working tree.

**It does *not*:** create branches, commit, push, or open PRs. Those stay in your
hands. You branch first, let the pipeline do the work, then review the diff and ship
it yourself.

## Layout

```
opencode-pipeline/
├── run-pipeline.mjs      # shared orchestrator + OpenRouter entry point
├── run-gpt-pipeline.mjs  # fixed-model ChatGPT subscription entry point
├── issue-launcher.mjs    # GitHub issue intake and safe branch preparation
├── config.mjs            # tiered/fixed config loading and validation
├── resolve-model.mjs     # cheapest-per-tier resolver against OpenRouter live pricing
├── setup.mjs             # installs the three pipeline agents into your opencode config
├── pipeline.config.json  # model tiers, stage → tier mapping, retry cap
├── gpt-pipeline.config.json # fixed Terra/Luna/Sol mapping, subscription billing
├── prompts/              # stage system prompts (plan / execute / review)
└── test/                 # node:test suite for the harness logic
```

The three agents (`pipeline-plan`, `pipeline-execute`, `pipeline-review`) are ordinary
OpenCode [markdown agents](https://opencode.ai/docs/agents/) with locked-down
permissions:

| Agent              | read  | edit  | bash                                     |
|--------------------|-------|-------|------------------------------------------|
| `pipeline-plan`    | allow | deny  | deny                                     |
| `pipeline-execute` | allow | allow | **ask** (read-only + test/lint commands pre-approved)|
| `pipeline-review`  | allow | deny  | deny                                     |

Only execute can ever prompt you. Plan and review are read-only and run without
interruption.

## Prerequisites

- OpenCode installed (`opencode --version`). OpenCode 1.18.5 is the tested
  baseline; runtime capability checks, rather than a hardcoded version check,
  decide whether GPT subscription mode can run.
- OpenRouter credentials for `opencode-pipeline`, or ChatGPT Plus/Pro OAuth for
  `opencode-gpt-pipeline` (setup below).
- For `--issue`, GitHub CLI installed and authenticated (`gh auth status`) with
  access to the target repository and issue.
- Node 20+ (`node --version`). There are no npm dependencies — the pipeline uses
  only the Node standard library.

## Install

```bash
git clone <this-repo-url> && cd opencode-pipeline
node setup.mjs
```

`setup.mjs` writes the three agents as markdown files into
`~/.config/opencode/agents/` (honoring `XDG_CONFIG_HOME`). It backs up any
pre-existing same-named file it didn't write, and `node setup.mjs --uninstall`
removes exactly what it installed (restoring any backup). If you'd rather
inspect first, run it once into a scratch config home:
`XDG_CONFIG_HOME=$(mktemp -d) node setup.mjs`.

**Restart any running `opencode serve` (and TUI) afterward** — agents are loaded
at startup. If your global `opencode.json`/`opencode.jsonc` already defines
`pipeline-*` agents inline, remove that block to avoid the definitions being
merged.

If installed as a package, the two binaries are:

```bash
opencode-pipeline "<task>" [target-dir]
opencode-pipeline --issue <number-or-url> [target-dir]
opencode-gpt-pipeline "<task>" [target-dir]
opencode-gpt-pipeline --issue <number-or-url> [target-dir]
```

The source-checkout equivalents are `node run-pipeline.mjs` and `node
run-gpt-pipeline.mjs`.

## GPT subscription quickstart

Authenticate OpenCode through ChatGPT OAuth, install the shared pipeline
agents, and restart the server so it sees both the credentials and agents:

```bash
opencode auth login
# Choose: OpenAI
# Choose: ChatGPT Plus/Pro

node setup.mjs
opencode serve --port 4747
```

Attach a TUI in another terminal, then run the GPT command:

```bash
opencode attach http://127.0.0.1:4747

PIPELINE_SERVER_URL=http://127.0.0.1:4747 \
  opencode-gpt-pipeline "<task>" <target-dir>
# From a source checkout: node run-gpt-pipeline.mjs "<task>" <target-dir>
```

Before creating any stage session, the GPT command queries OpenCode's
`/provider` registry and requires all of the following:

- `openai` is connected.
- `openai/gpt-5.6-terra`, `openai/gpt-5.6-luna`, and
  `openai/gpt-5.6-sol` are available.
- Every model has present, zero-valued cost metadata, confirming
  subscription-backed routing.

If any check fails, the command exits with the OAuth steps above. OpenAI API-key
authentication is intentionally rejected because it carries nonzero API
pricing; there is no fallback to an API key, OpenRouter, or another model.
Subscription usage remains subject to your ChatGPT plan's allowance and limits.

### Run an open GitHub issue

Issue mode reduces supervision to one foreground command. It requires the
OpenCode server and approval TUI to be running already; it uses
`PIPELINE_SERVER_URL`, or `http://127.0.0.1:4747` by default:

```bash
# In the target repository (or pass it as the final argument):
# Price-aware OpenRouter route:
opencode-pipeline --issue 123

# Fixed ChatGPT subscription route:
opencode-gpt-pipeline --issue 123
opencode-gpt-pipeline --issue https://github.com/owner/repo/issues/123 /path/to/repo
```

The launcher fails before model work if `gh` is unavailable, the issue is
closed or belongs to another repository, the tree is dirty, the server is
unreachable, the selected model route cannot preflight, or the running server
has missing/stale pipeline prompts. It sends the issue title, body, labels, and
all comments to the plan stage without model-generated summarization.

The OpenRouter command resolves its three models against live pricing before
creating a branch, freezes that model snapshot for the run, and retains the
normal dollar receipt. `PIPELINE_CONFIG` overrides continue to apply. The GPT
command performs its subscription-routing check instead and retains its
allowance-only output.

On a clean non-default branch, the launcher uses that branch unchanged. On the
default branch, it fetches `origin/<default>`, requires local and remote tips to
match, and creates `issue-<number>-<sanitized-title>`. It refuses to reuse an
existing branch with that name; inspect and select that branch explicitly if
you intend to resume it. The launcher streams the normal pipeline output and
returns its PASS/FAIL exit code. It never commits, pushes, opens a PR, or grows
the diff after review.

A lightweight supervising agent can be told:

> Run `opencode-pipeline --issue 123 /path/to/repo` (or the GPT command) in the foreground with
> enough time for the pipeline to finish. Monitor and report its final result;
> do not implement, commit, or push anything yourself. I will handle approval
> asks in the separately attached TUI.

## Terminal setup

The pipeline talks to a running `opencode serve`. Permission prompts appear in a
**separately attached TUI**, so you generally want two terminals plus the one you
run the pipeline from. If the TUI is missing or attaches late, nothing is
stranded: the pipeline announces every pending approval ask in its own output,
with copy-paste commands to answer it over the HTTP API from any terminal (see
*Notes & gotchas*).

### Recommended: bring your own server (3 terminals)

**Terminal 1 — the server** (leave it running):
```bash
opencode serve --port 4747
```

**Terminal 2 — the TUI where you approve commands** (leave it running):
```bash
opencode attach http://127.0.0.1:4747
```

**Terminal 3 — run the pipeline**, pointing it at that server:
```bash
export PIPELINE_SERVER_URL=http://127.0.0.1:4747
node run-pipeline.mjs "<task>" <target-dir>
```
With `PIPELINE_SERVER_URL` set, the script attaches to your existing server and
does **not** spawn or tear one down.

### Alternative: let the script manage the server (2 terminals)

Omit `PIPELINE_SERVER_URL`. The script spawns its own `opencode serve` (on
`PIPELINE_SERVER_PORT`, default `4747`), waits until it's ready, prints the exact
`opencode attach` command, and pauses:

```
Attach a TUI in another terminal:
  opencode attach http://127.0.0.1:4747
Press Enter once the TUI is attached...
```

Attach in a second terminal, press Enter, and it runs — then kills its server on
exit (including on Ctrl-C).

Either way: as each stage starts, the pipeline nudges your attached TUI to that
stage's session, so the execute stage's approval prompts land in front of you.

## Worked example — fixing a GitHub issue

Say issue **#123** on `acme/widgets` needs fixing.

### 1. Start the server and TUI

Terminals 1 and 2 as above (`opencode serve --port 4747` / `opencode attach
http://127.0.0.1:4747`).

### 2. Branch first — the pipeline edits the working tree in place

```bash
cd ~/src/widgets
git switch main && git pull
git switch -c fix/123-<short-slug>
```

### 3. Turn the issue into the task string

Feed the issue's title and body straight in as the task. Be explicit about how to
verify the fix so the execute stage actually runs the project's checks (and you
get to approve them):

```bash
TASK="$(gh issue view 123 --repo acme/widgets \
        --json title,body --jq '"\(.title)\n\n\(.body)"')

When done, verify by running: pytest -q.
Do not commit, push, or change git branches."
```

### 4. Run the pipeline against the checkout

From your `opencode-pipeline` clone:

```bash
export PIPELINE_SERVER_URL=http://127.0.0.1:4747
node run-pipeline.mjs "$TASK" ~/src/widgets
```

### 5. Approve commands live in the TUI (Terminal 2)

- **plan** runs read-only — no prompts.
- **execute** edits files and, when it wants to run something like `pytest -q` or
  a build, the TUI shows the exact command and waits. Approve the ones you
  expect; reject anything that looks wrong (a rejection is fed back to the agent
  as feedback, not a crash).
- **review** runs read-only, prints its findings, and returns PASS/FAIL.

### 6. Inspect, then ship it yourself

```bash
cd ~/src/widgets
git diff
pytest -q                       # re-run the gate yourself to be sure
git add -A && git commit -m "Fix #123: <summary>"
git push -u origin fix/123-<short-slug>
gh pr create --fill
```

The pipeline's own PASS is a strong signal, not a substitute for your eyes on the
diff and a clean local test run before you open the PR.

## Configuration

### `pipeline.config.json`

```json
{
  "tiers": {
    "cheap":      ["anthropic/claude-sonnet-5", "openai/gpt-5.6-terra", "google/gemini-3.1-pro-preview"],
    "smart":      ["anthropic/claude-opus-4.8", "openai/gpt-5.6-sol", "moonshotai/kimi-k3"],
    "very-smart": ["anthropic/claude-fable-5", "openai/gpt-5.5-pro"]
  },
  "stageTiers": { "plan": "smart", "execute": "cheap", "review": "very-smart" },
  "maxRetries": 2
}
```

- **tiers** — your candidate lists; IDs must match OpenRouter's catalog exactly.
  The cheapest listed model that OpenRouter currently prices wins (blended score,
  weighting completion 4× prompt since coding is output-heavy). Add your own
  tiers and point stages at them. Only `tiers` is required; `stageTiers` and
  `maxRetries` fall back to the defaults shown.
- Check what would be chosen right now without running anything:
  ```bash
  node resolve-model.mjs smart
  ```
- `PIPELINE_CONFIG` points at a different config file if you keep several.

Legacy tier configs without `modelStrategy` remain supported. Their normalized
strategy is `tiered` and billing mode is `openrouter`.

### Fixed GPT configuration

`gpt-pipeline.config.json` is bundled with the package:

```json
{
  "modelStrategy": "fixed",
  "stageModels": {
    "plan": "openai/gpt-5.6-terra",
    "execute": "openai/gpt-5.6-luna",
    "review": "openai/gpt-5.6-sol"
  },
  "billingMode": "chatgpt-subscription",
  "maxRetries": 2
}
```

Fixed configs require all three stages and cannot contain `tiers` or
`stageTiers`; tiered configs cannot contain `stageModels`. The dedicated GPT
command always uses this bundled file, so `PIPELINE_CONFIG` continues to affect
the original OpenRouter command without changing GPT's fixed model contract.

### Prompts

The stage system prompts are plain text in `prompts/`; `setup.mjs` embeds them
into the installed agent files, so re-run `node setup.mjs` (and restart your
server) after editing them. Plan and execute own their `PLAN_RESULT` and
`EXECUTE_RESULT` completion contracts. Review owns the `REVIEW_RESULT: PASS` /
`REVIEW_RESULT: FAIL: <reason>` verdict and `REQUIRED_FIXES` repair packet that
drive the retry loop. Edit these contracts carefully; the orchestrator parses
their sentinels directly.

### Environment variables

| Variable                          | Default         | Purpose |
|-----------------------------------|-----------------|---------|
| `PIPELINE_SERVER_URL`             | *(unset)*       | Attach to an already-running server at this URL; skip spawn/teardown. Issue mode defaults it to localhost using `PIPELINE_SERVER_PORT`. |
| `PIPELINE_SERVER_PORT`            | `4747`          | Port for the server the script spawns (ignored if `PIPELINE_SERVER_URL` is set). |
| `PIPELINE_CONFIG`                 | `pipeline.config.json` next to the scripts | Path to the pipeline config file. |
| `PIPELINE_STAGE_TIMEOUT_MS`       | `1800000` (30m) | How long a single stage may run before timing out. Generous because you may take time to approve. |
| `PIPELINE_PERMISSION_POLL_MS`     | `3000`          | How often the pipeline polls the server for pending approval asks while a stage runs. |
| `PIPELINE_PERMISSION_REMINDER_MS` | `30000`         | How often an unanswered ask is re-announced in the pipeline's output. |

## Reading the output

```
[plan] running openrouter/moonshotai/kimi-k3...
[plan] done (cost $0.010214)
[execute] running openrouter/anthropic/claude-sonnet-5...
[execute] done (cost $0.031755)
[review] running openrouter/anthropic/claude-fable-5...
[review] done (cost $0.008430) -> PASS

--- review findings ---
(the reviewer's full notes and reasoning, verbatim)
-----------------------

--- Pipeline summary ---
  plan             openrouter/moonshotai/kimi-k3          $0.010214
  execute          openrouter/anthropic/claude-sonnet-5   $0.031755
  review           openrouter/anthropic/claude-fable-5    $0.008430
  total cost: $0.050399
  result: PASS
```

- A FAIL retry appears as extra `execute-retry1` / `review-retry1` rows.
- The review stage's full findings print verbatim after its verdict — notes
  that don't rise to FAIL land there, so read them even on a PASS.
- Exit code is `0` for PASS, `1` for FAIL — usable in a shell `&&` chain.

GPT mode reports allowance usage instead of a dollar receipt:

```text
[plan] running openai/gpt-5.6-terra...
[plan] done (ChatGPT subscription allowance)
[execute] running openai/gpt-5.6-luna...
[execute] done (ChatGPT subscription allowance)
[review] running openai/gpt-5.6-sol...
[review] done (ChatGPT subscription allowance) -> PASS

--- Pipeline summary ---
  plan             openai/gpt-5.6-terra                     ChatGPT subscription allowance
  execute          openai/gpt-5.6-luna                      ChatGPT subscription allowance
  review           openai/gpt-5.6-sol                       ChatGPT subscription allowance
  billing: ChatGPT subscription allowance
  result: PASS
```

## Notes & gotchas

- **Approval asks are announced by the pipeline itself.** While a stage runs, the
  pipeline polls the server's pending-permission list (`GET /permission`) every
  few seconds. Any ask is printed — what command is being requested, plus
  copy-paste `curl` commands answering it via `POST /permission/<id>/reply` with
  `{"reply":"once"|"always"|"reject"}` — and re-printed every 30s until answered.
  This works with zero TUIs attached, and for asks that fired *before* your TUI
  attached (whose dialog a late-attached TUI may not re-present). Answering via
  the API resolves the actual pending request, whatever the TUI is showing.
  **Permission endpoints are directory-scoped:** every call needs
  `?directory=<project-dir>` — without it the list reads empty and replies 404
  (the server falls back to its own cwd). The printed commands already include
  it; add it if you ever query `/permission` by hand.
- **Never type an approval into the TUI's prompt box.** Typed text is queued as a
  chat message to the agent; it does not answer the pending ask. Use the TUI's
  approval dialog or the printed API command.
- **The pipeline can't verify a TUI is attached.** `POST /tui/select-session`
  returns success even when no TUI is listening, so attachment can't be probed —
  the announcements above are the safety net. If an ask is announced but your TUI
  shows nothing, answer it with the API command and re-attach the TUI.
- **Branch before running.** The execute agent edits your working tree directly.
  It's told not to touch git, but you own that guarantee — start from a clean
  feature branch so `git diff` shows exactly what it did. The reviewer's diff
  view is captured from git too — a non-git target gets a weaker, files-only
  review.
- **Rejecting a command isn't fatal.** A rejection in the TUI is returned to the
  agent as a failed tool call; it will adapt. Use it to steer.
- **Stages do not share conversational memory.** Context is passed explicitly
  from plan to execute and from execute to review. Review attempts are fresh;
  execute retries deliberately reuse one execute session so repair feedback
  lands alongside the implementation conversation that produced the diff.
- **Billing depends on the command.** OpenRouter runs spend OpenRouter credit
  and print a receipt. GPT runs consume ChatGPT subscription allowance, remain
  subject to plan limits, and intentionally omit dollar-cost reporting.
- **Scope tasks tightly.** One issue per run. A vague or sprawling task produces
  a vague plan and a shakier review verdict.
- **If a stage ever hangs** past when the TUI clearly shows it finished, Ctrl-C
  and re-run — but this shouldn't happen: each stage's `/global/event`
  subscription is established (awaited) before its prompt is sent, so the
  `session.idle` completion event can't be missed. If a stage legitimately runs
  long (e.g. you stepped away before approving a command), raise
  `PIPELINE_STAGE_TIMEOUT_MS`.

## Uninstall

```bash
node setup.mjs --uninstall   # removes the three agent files it installed
```

Then delete the clone. Your OpenCode/OpenRouter login is untouched.

## Development

```bash
node --test
node --check run-pipeline.mjs
node --check run-gpt-pipeline.mjs
```

The harness's fiddly bits — review-sentinel parsing, tier resolution, config
loading, fixed-model resolution, subscription preflight, billing output, and
permission reply commands — are unit-tested. Zero dependencies; please keep it
that way unless a dependency earns its place.

## License

[MIT](LICENSE)
