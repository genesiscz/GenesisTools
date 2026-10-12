---
paths:
  - "src/say/**"
---

# tools say (src/say/)

Loaded by Claude Code when you read, write or edit a file under `src/say/`.

`tools say` loads voice / volume / provider / model / language / format from a per-app profile (`--app <name>`), inheriting unset fields from a `default` profile. Notable rules:

- `--save` persists explicitly-passed flags to `--app`'s profile (requires `--app`; in TTY without it, prompts; in non-TTY, errors).
- `--save` with no message text is a save-only invocation (does not speak, does not enter interactive mode).
- `--mute` / `--unmute` require `--save` to persist (breaking change vs. older builds — they are no longer standalone state-write commands).
- `--unset <fields>` (comma-separated): without `--save`, ignores those fields for this run; with `--save`, deletes the keys from the saved profile.
- Run `tools say config` for an interactive profile manager.
- Config lives at `~/.genesis-tools/say/config.json`; old v1 configs are auto-migrated and the original is backed up once to `config.v1.bak.json`.

So when you write the end-of-task notification, you can typically rely on a saved `claude` profile and just call `tools say "<xxx> done" --app claude` — voice etc. come from the profile.
