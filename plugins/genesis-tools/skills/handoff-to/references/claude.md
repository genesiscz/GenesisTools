# Claude mechanics (a second Claude account via `tools claude exec`)

Read this after `gt:handoff-to` has picked Claude-as-a-separate-worker and the readiness gate has passed.

## First: is this the right backend at all?

There are two ways to hand work to a Claude model, and they are not interchangeable.

| You want | Use | Why |
|---|---|---|
| A subagent inside this session | `Agent` tool with `model: "sonnet" \| "opus" \| "fable"` | Cheapest, keeps the harness, shares this session's account |
| Fan-out across many subagents | `Workflow` | Same account, deterministic orchestration |
| A worker on a **different account**, or a headless `claude -p` run | **this file** | Separate billing identity, separate context, survives this session |

**Default to the `Agent` tool.** Reach for `tools claude exec` only when the point is the *account* or the *separate process*: spreading usage across accounts, running under a subscription this session is not on, or launching a long headless run that must not consume this session's context.

## The command

```bash
tools claude exec -a <account> -- \
  claude -p "$(cat /tmp/claude-<task>-brief.md)" \
    --model sonnet \
    --output-format json
```

Use `--output-format json` (or `stream-json`) rather than the default text whenever a driver, not a human, reads the result. See § Structured output.

`tools claude exec [-a <account>] [--no-verify] [--] <command> [args...]` runs any command with that account's long-lived token pinned into its environment. It is the supported path for `claude -p` in hooks, CI, and handoffs, precisely so the run never depends on whichever account the keychain happens to hold.

Verified live 2026-08-27 in this repo:

- The child really is pinned: `TOOLS_CLAUDE_ACCOUNT` matches the named account and `CLAUDE_CODE_OAUTH_TOKEN` is present at 108 characters (`pinnedLaunchEnv()`, `src/claude/lib/launch-env.ts:77-91`).
- `exec` exits with the **child's** exit code (`src/claude/commands/exec.ts:205`), so a failing `claude -p` fails your handoff. A missing binary exits 127.
- The `▸ … (as <account>, token pinned)` banner is written **only when stderr is a TTY** (`exec.ts:192`), so capturing stderr in a script does not splice it into your data.

## 🛑 Always pass `-a`. Omitting it silently picks an account for you.

With no `-a` and no TTY, `exec` calls `autoPick()` and chooses by usage headroom (`exec.ts:91-109`). Verified: an invocation with an empty `-a` ran as an account that was never named, and exited 0 with no warning. In a handoff that means the work bills an account you did not choose, and you will not notice.

Name the account explicitly, every time. Naming one that is not eligible is safe and loud:

```
✘ Account "<name>" has no long-lived token.
With a token: <the eligible accounts>
```

Eligible means provider `anthropic-sub` **and** a stored long-lived token (`exec.ts:153`). List them with `tools ai config account list`, or trigger the error above on purpose to see the exact set. Attach a token to an account with `tools claude login-long <account>`.

## What `exec` guards for you

- **A truncated token is refused before the spawn.** Under 100 characters (`LONG_TOKEN_MIN_LENGTH`, `src/utils/claude/token-verify.ts:18`) it hard-fails and tells you to recapture. This matters because a truncated token 401s and Claude Code then **silently falls back to the keychain login**, so the run bills the wrong account rather than failing.
- **A read-only probe runs before the spawn** (a GET, no billing). Only a definitive `invalid` (401/403) blocks. `limited` still launches, because it is the right identity with no headroom, and `unreachable` still launches so a network blip cannot ground a CI job. Skip it with `--no-verify` only when you already know the token is good.
- **`tools claude doctor`** finds running pinned sessions that are silently billing the keychain account instead of their pin. Worth running if a handoff's usage lands somewhere unexpected.

## Use headless `-p`, not interactive `tools claude run`

`tools claude run` launches an interactive Claude Code. It is the right tool when a human is driving and the wrong tool for an unattended worker, for reasons that hold independently of anything else: it expects a TTY, it returns prose rather than parseable output, and it gives you no way to steer a running turn.

⚠️ There is also a dated billing observation: Claude Code **2.1.202** was seen swapping `CLAUDE_CODE_OAUTH_TOKEN` for keychain credentials *after startup*, so an interactive session began billing a different account mid-run, while headless `-p` was unaffected. That has **not** been re-tested on the current build (2.1.238 as of 2026-08-27). Treat it as a reason to prefer `-p`, not as a current fact about `run`. If you need to know, `tools claude doctor` scans running pinned sessions for exactly this silent-fallback failure.

## Model and effort

Pass them to the child, not to `exec`:

```bash
tools claude exec -a <account> -- claude -p "<brief>" --model opus
```

Pick the model from `gt:handoff-to` § Model rankings. Note the taste/intelligence tradeoff still applies: this backend changes *who pays*, not *how good the model is*.

## Brief and checkpoints

The readiness gate in `gt:handoff-to` applies unchanged. A `claude -p` run is **one shot with no approvals**, so it behaves like the grok resume loop rather than the Codex daemon: there is no mid-turn steering and nothing to approve. Slice the work so a single turn ends at a checkpoint, and put this in the brief, filled in:

```markdown
## Stop and report — do not continue past these
- This turn: <single milestone> ONLY. Report what changed + the verify output, then STOP.
- Do NOT create new files, do NOT commit or push, do NOT touch <paths>.
- If the verify command fails twice in a row: STOP and report both outputs. Do not keep patching.
- Copy every file path from this brief CHARACTER FOR CHARACTER. Do not retype or normalize them.
```

⚠️ **A `-p` worker inherits the target repo's project configuration.** It runs as a real Claude Code in whatever directory you launch it from, so that repo's `CLAUDE.md`, hooks and permission rules all apply. Point it at a scratch directory or a worktree when that is not what you want.

Write the brief to a file and read it in with `"$(cat …)"` rather than inlining prose, for the same quoting reasons as the other backends.

## Structured output — do not parse prose

Bare `claude -p` returns plain text, which is fine for a human and bad for a driver. Ask for JSON instead:

```bash
tools claude exec -a <account> -- claude -p "<brief>" --output-format json            # one result object
tools claude exec -a <account> -- claude -p "<brief>" --output-format stream-json     # NDJSON, realtime
```

`--output-format` accepts `text` (default), `json`, and `stream-json`. Add `--include-partial-messages` for token-level deltas on the streaming form, and `--json-schema '<schema>'` to constrain the final answer to a shape you can validate instead of eyeballing.

For a **steerable** session, pair it with streaming input:

```bash
claude -p --input-format stream-json --output-format stream-json --replay-user-messages
```

`--input-format stream-json` takes realtime streaming input, so you can send further messages into a running turn rather than only resuming between turns. `--replay-user-messages` echoes your own messages back on stdout so you can acknowledge them. This is the closest Claude equivalent to the Codex app-server loop.

## Sandboxing

`exec` pins credentials; it does **not** sandbox. The child is a normal process with your filesystem access, and `claude -p` decides its own tool use subject to that repo's permission rules. There is no `--write deny` equivalent here.

That does not make a read-only Claude handoff impossible, it makes it *your* job:

- State the constraint plainly in the brief ("do NOT write, edit, commit, or run anything that mutates state; your written answer is the deliverable"). Workers honor negative constraints reliably when they are spelled out.
- Verify it rather than trusting it: `git -C <cwd> status --short` must be empty when the turn ends.
- For anything the user did not explicitly ask for, isolate by *location*: a `git worktree add` scratch checkout or a temp directory. Never point an unattended writable `-p` run at the user's live working tree on your own initiative.

## Verify, then integrate

Never trust the self-report. Run the verification command yourself, read `git diff` in the worker's directory, and only then integrate. Nothing to tear down: when the process exits, the handoff is over.

## Driver mode

For a long multi-turn Claude handoff, spawn a `genesis-tools:agent-driver` subagent with `BACKEND: claude` so the run's output stays out of this session.

Give the first turn a session id you chose, so resuming never depends on scraping one back out:

```bash
uuid=$(uuidgen)
tools claude exec -a <account> -- claude -p "<brief>" --session-id "$uuid" --model sonnet
tools claude exec -a <account> -- claude -p "<correction>" --resume "$uuid"      # every later turn
```

`--session-id <uuid>` and `-r, --resume [value]` are both real flags on the installed `claude` CLI (verified 2026-08-27). Keep the same `-a <account>` on every turn so the whole handoff bills one identity, and confirm it rather than assuming it stuck.
