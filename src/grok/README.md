# tools grok

Drive xAI's `grok` CLI as an isolated headless worker. This is the grok counterpart of `tools codex`: you architect and verify, the worker implements. There is no daemon and no approval channel — the drive model is a resume loop, one blocking invocation per turn, steering between turns.

## Commands

```bash
tools grok run --name fix-auth --cwd /abs/project --prompt-file /tmp/brief.md [--readonly] [--model grok-4.6]
tools grok steer --name fix-auth --prompt "Now fix the second bug; still do not touch tests"
tools grok read --name fix-auth [--turn 2]
tools grok sessions
```

`run` and `steer` block until the turn ends (minutes). From an agent, run them in background Bash and wait for the completion notification.

## What the harness bakes in

- **Isolation.** Workers get `GROK_HOME=~/.genesis-tools/grok/worker-home` and the `GROK_CLAUDE_*_ENABLED=0` toggles, so they never load the user's `~/.claude` rules, permission settings, or personal skills. Override the home with `--worker-home` for parallel or test isolation, and keep it constant per session (sessions live inside it).
- **Session bookkeeping.** The session uuid and cwd are stored in `~/.genesis-tools/grok/sessions/<name>.meta.json`; `steer` resumes with the identical `--cwd` automatically (grok keys sessions by cwd).
- **Sticky read-only.** The grok CLI forgets `--tools` on every `--resume`; the harness re-arms the read-only allowlist on each steer of a `--readonly` session. `steer --writable` switches the session back to the project jail deliberately.
- **Honest exit codes.** The grok CLI exits 0 even when a turn dies. `tools grok` parses the stream and exits 1 when no terminal `end` event is present.

## Safety model (verified against grok CLI 1.0.3, 2026-08-26)

- Default headless mode is a **project jail**: edits and commands inside `--cwd` run without approval; writes outside are blocked with a denial the worker sees.
- `--readonly` maps to the `--tools read_file,list_dir,grep` allowlist — the worker physically lacks edit and terminal tools.
- Do not hand-roll bare `grok` flags for safety: `--permission-mode plan` does not restrict headless runs, and `--disallowed-tools` silently keeps `run_terminal_command`.

Skill: `gt:handoff-to` § Grok mechanics (readiness gate, checkpoint contract, verification discipline).
