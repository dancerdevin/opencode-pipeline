# opencode-pipeline

A cost-aware **plan → execute → review** pipeline over [OpenCode](https://opencode.ai)
+ OpenRouter, with a human (you) approving every shell command live.

Each stage runs as its own OpenCode session using a different model *tier*, and the
cheapest model in each tier is chosen at runtime from OpenRouter's live pricing.
You stay at the terminal: the execute stage's `bash` calls surface in an attached
OpenCode TUI for you to approve or reject as they happen.

- **plan** — a *smart*-tier model reads the repo (read-only) and writes an ordered
  implementation plan.
- **execute** — a *cheap*-tier model carries out the plan: edits files and runs
  commands. **Every `bash` command pauses for your approval** (read-only inspection
  commands like `ls`, `grep`, `git diff` are pre-approved).
- **review** — a *very-smart*-tier model inspects the actual diff (read-only) and
  emits `REVIEW_RESULT: PASS` or `REVIEW_RESULT: FAIL: <reason>`. On FAIL the
  execute stage retries with the reason folded in, up to `maxRetries` times.

The pipeline exits `0` on PASS, `1` on FAIL, and prints a per-stage cost summary.

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
├── run-pipeline.mjs      # orchestrator (entry point)
├── resolve-model.mjs     # cheapest-per-tier resolver against OpenRouter live pricing
├── setup.mjs             # installs the three pipeline agents into your opencode config
├── pipeline.config.json  # model tiers, stage → tier mapping, retry cap
├── prompts/              # stage system prompts (plan / execute / review)
└── test/                 # node:test suite for the harness logic
```

The three agents (`pipeline-plan`, `pipeline-execute`, `pipeline-review`) are ordinary
OpenCode [markdown agents](https://opencode.ai/docs/agents/) with locked-down
permissions:

| Agent              | read  | edit  | bash                                     |
|--------------------|-------|-------|------------------------------------------|
| `pipeline-plan`    | allow | deny  | deny                                     |
| `pipeline-execute` | allow | allow | **ask** (read-only commands pre-approved)|
| `pipeline-review`  | allow | deny  | deny                                     |

Only execute can ever prompt you. Plan and review are read-only and run without
interruption.

## Prerequisites

- OpenCode installed (`opencode --version`) and logged in to OpenRouter
  (`opencode providers login`).
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
removes exactly what it installed. If you'd rather inspect first, run it once
into a scratch config home: `XDG_CONFIG_HOME=$(mktemp -d) node setup.mjs`.

**Restart any running `opencode serve` (and TUI) afterward** — agents are loaded
at startup. If your global `opencode.json`/`opencode.jsonc` already defines
`pipeline-*` agents inline, remove that block to avoid the definitions being
merged.

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
- **review** runs read-only and returns PASS/FAIL.

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

### Prompts

The stage system prompts are plain text in `prompts/`; `setup.mjs` embeds them
into the installed agent files, so re-run `node setup.mjs` (and restart your
server) after editing them. The **review** prompt owns the `REVIEW_RESULT: PASS`
/ `REVIEW_RESULT: FAIL: <reason>` contract that drives the retry loop — edit it
carefully; the orchestrator parses that sentinel with a regex and takes the last
match.

### Environment variables

| Variable                          | Default         | Purpose |
|-----------------------------------|-----------------|---------|
| `PIPELINE_SERVER_URL`             | *(unset)*       | Attach to an already-running server at this URL; skip spawn/teardown. |
| `PIPELINE_SERVER_PORT`            | `4747`          | Port for the server the script spawns (ignored if `PIPELINE_SERVER_URL` is set). |
| `PIPELINE_CONFIG`                 | `./pipeline.config.json` | Path to the pipeline config file. |
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

--- Pipeline summary ---
  plan             openrouter/moonshotai/kimi-k3          $0.010214
  execute          openrouter/anthropic/claude-sonnet-5   $0.031755
  review           openrouter/anthropic/claude-fable-5    $0.008430
  total cost: $0.050399
  result: PASS
```

- A FAIL retry appears as extra `execute-retry1` / `review-retry1` rows.
- Exit code is `0` for PASS, `1` for FAIL — usable in a shell `&&` chain.

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
  feature branch so `git diff` shows exactly what it did.
- **Rejecting a command isn't fatal.** A rejection in the TUI is returned to the
  agent as a failed tool call; it will adapt. Use it to steer.
- **Each stage is a fresh session** with no memory of the others — context is
  passed explicitly (plan text into execute, plan + execute summary into
  review). This is deliberate; don't expect cross-stage conversational
  continuity.
- **Cost is real.** Every run spends OpenRouter credit (typically a few cents
  for a small issue). The summary is your receipt.
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
```

The harness's fiddly bits — review-sentinel parsing, tier resolution, config
loading, permission reply commands — are unit-tested. Zero dependencies; please
keep it that way unless a dependency earns its place.

## License

[MIT](LICENSE)
