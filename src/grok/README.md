# tools grok

Drive xAI's `grok` CLI as an isolated headless worker. This is the grok counterpart of `tools codex`: you architect and verify, the worker implements. There is no daemon and no approval channel — the drive model is a resume loop, one blocking invocation per turn, steering between turns.

## Commands

```bash
tools grok run --name fix-auth --cwd /abs/project --prompt-file /tmp/brief.md [--readonly] [--model grok-4.6]
tools grok run --resume [query]          # TUI: grok -r <id>; query matches id, title, or transcript
tools grok resume [query]                # alias of TUI resume
tools grok history [query] [--all] [--format json] [-i]
tools grok steer --name fix-auth --prompt "Now fix the second bug; still do not touch tests"
tools grok read --name fix-auth [--turn 2]
tools grok sessions

tools grok login [name] [--home ~/.grok]     # runs `grok login` when the file is missing, then binds its auth.json
tools grok usage [--json] [--range 24h]      # the shared usage dashboard pinned to this provider
```

`login` and `usage` are doors onto the provider-neutral account core: the same code runs behind `tools ai accounts login --provider grok` and `tools ai usage --provider grok`. xAI has no in-process OAuth flow, so `login` prints the vendor command with `GROK_HOME` set, offers to run it, and binds the `auth.json` it wrote. `usage` reports the monthly billing credit rather than percentage windows.

`run` and `steer` block until the turn ends (minutes). From an agent, run them in background Bash and wait for the completion notification.

## What the harness bakes in

- **Isolation.** Workers get `GROK_HOME=~/.genesis-tools/grok/worker-home` and the `GROK_CLAUDE_*_ENABLED=0` toggles, so they never load the user's `~/.claude` rules, permission settings, or personal skills. `--worker-home` overrides that home for parallel or test runs. It does **not** move the session records: those stay under `~/.genesis-tools/grok/sessions/` so `tools grok sessions` can list every worker, so two runs sharing a `--name` share one record whatever their home. Project-local config in the target repo (`CLAUDE.md`, a `.grok/` directory) still loads — `GROK_HOME` redirects user state only.
- **Two session stores.** `tools grok history` / `run --resume` list TUI dirs under `~/.grok/sessions` (and the worker-home copy of that layout). `tools grok sessions` lists headless workers under `~/.genesis-tools/grok/sessions/<name>.meta.json`. Those are not the same inventory.
- **TUI resume is not the worker.** `--resume` on `run` launches `grok -r <id>` with your normal env. It never sets `GROK_HOME` and never calls `runSession`. Worker mode still needs `--name` and `--cwd` with `--resume` absent.
- **Session bookkeeping.** The worker uuid and cwd are stored in `~/.genesis-tools/grok/sessions/<name>.meta.json`; `steer` resumes with the identical `--cwd` automatically (grok keys sessions by cwd).
- **Sticky read-only.** The grok CLI forgets `--tools` on every `--resume`; the harness re-arms the read-only allowlist on each steer of a `--readonly` session. `steer --writable` switches the session back to the project jail deliberately.
- **Honest exit codes.** The grok CLI exits 0 even when a turn dies. `tools grok` parses the stream and exits 1 when no terminal `end` event is present.
- **One claim per name, one transcript per turn.** `run` reserves the session name with `O_EXCL`, and each turn reserves its own log file the same way, so two concurrent invocations cannot both start turn 1 or truncate each other's transcript.

## Safety model (verified against grok CLI 1.0.3, 2026-08-26)

- Default headless mode is a **project jail**: edits and commands inside `--cwd` run without approval; writes outside are blocked with a denial the worker sees.
- `--readonly` maps to the `--tools read_file,list_dir,grep` allowlist — the worker physically lacks edit and terminal tools.
- Do not hand-roll bare `grok` flags for safety: `--permission-mode plan` does not restrict headless runs, and `--disallowed-tools` silently keeps `run_terminal_command`.

## Authentication

`tools grok` never authenticates for you. It resolves the `grok` binary on PATH and nothing else, so an unauthenticated CLI produces a turn that starts and then fails inside grok rather than a clear error up front.

- Authenticate the CLI itself: `XAI_API_KEY` in the environment, or `grok login`.
- The worker inherits your environment, so `XAI_API_KEY` reaches it. The `GROK_CLAUDE_*_ENABLED=0` toggles switch off `~/.claude` pickup, not credentials.
- `--worker-home` gives a run its own `GROK_HOME`. A fresh home has no stored login, so a run pointed at one needs `XAI_API_KEY` in the environment.

Failure shapes:

| Symptom | Cause |
|---|---|
| `grok CLI not found on PATH` | binary missing — this check does not look at credentials |
| turn exits non-zero on turn 1 with auth text in `.err` | binary present, not authenticated |
| turn 1 works, a `--worker-home` run does not | credentials were in the default home, not the environment |

## When a turn fails

Nothing is rolled back, and that is deliberate: a dead turn's transcript is the evidence.

- **Read it.** `tools grok read --name <name> --turn <n>`. Raw log and stderr live at `~/.genesis-tools/grok/sessions/<name>.turn<n>.jsonl` and `.turn<n>.err`.
- **A turn that died mid-flight** (no terminal `end` event) exits 1 and prints stderr. The session stays resumable: `tools grok steer` starts the next turn number.
- **`Turn <n> ... already has a transcript`** means that turn number is reserved — another turn is running, or one died uncleanly. The reservation is intentional; it is what stops a second invocation truncating the first's transcript. Read turn `n` first, then remove its `.jsonl` only if you are certain no process is still writing to it.
- **`Grok session '<name>' already exists`** means the name is claimed. Steer it or pick another name.
- **A session missing from `tools grok sessions`** has metadata with a blank or absent `sessionId`, which cannot be resumed. It is skipped rather than shown as a resumable row that would silently start a new conversation.

Skill: `gt:handoff-to`, then `references/grok.md` (readiness gate, checkpoint contract, verification discipline).
