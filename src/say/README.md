# Say

![Status](https://img.shields.io/badge/Status-Active-success?style=flat-square)
![Platform](https://img.shields.io/badge/Platform-macOS-blue?style=flat-square)

> **Text-to-speech with per-app config profiles, multiple backends (macOS / xAI / OpenAI), and saved-and-recalled defaults.**

A `say` CLI that loads its voice / volume / provider / rate / model / language / format from a named profile (`--app <name>`), so callers don't have to re-pass flags every invocation. Profiles inherit unset fields from a `default` profile.

---

## Quick Start

```bash
# One-shot speech with system defaults
tools say "Build finished"

# Save settings under an app profile
tools say --app claude --voice Samantha --provider macos --save

# Subsequent calls just use the profile — no flags needed
tools say "x done" --app claude

# Override one field on a single run (does NOT persist)
tools say "x done" --app claude --voice Daniel

# Manage profiles interactively
tools say config
```

---

## Profiles & inheritance

Config lives at `~/.genesis-tools/say/config.json`. Every app entry carries the full schema — fields are `null` when they should fall through to `default`:

```json
{
    "version": 2,
    "global": { "mute": false },
    "apps": [
        {
            "name": "default",
            "voice": "Samantha",
            "volume": 0.5,
            "provider": null,
            "rate": null,
            "model": null,
            "format": null,
            "language": null,
            "mute": null
        },
        {
            "name": "claude",
            "voice": "Daniel",
            "volume": null,
            "provider": null,
            "rate": null,
            "model": null,
            "format": null,
            "language": null,
            "mute": null
        },
        {
            "name": "build",
            "voice": "alloy",
            "volume": null,
            "provider": "openai",
            "rate": null,
            "model": "tts-1",
            "format": null,
            "language": null,
            "mute": null
        }
    ]
}
```

Resolution for a given run, **most-specific wins**:

1. Explicit CLI flag on this invocation
2. The `--app <name>` profile's field (if present)
3. The `default` profile's field
4. Provider / built-in default

Mute is a logical-OR of `global.mute` and the app's **own** `mute` field — either is sufficient to silence. (Note: `mute` does not inherit from `default` to other apps; if you want a single switch that silences everything, use `global.mute`.)

`null` / missing on a per-app field means **inherit**, not "use null". So `apps[claude]` with `"volume": null` picks up `default.volume`.

Some fields are provider-specific:

- `rate` — normalized `0..2` multiplier (or `0..200%`). `0`=slowest, `1`=default cadence, `2`=fastest. Provider speeds are matched to macOS native (~0.81×..1.86×) so the same `--rate` sounds identical on macOS, xAI, and OpenAI.
- `model` — OpenAI only (`tts-1`, `gpt-4o-mini-tts`). xAI uses a hardcoded model; macOS ignores it.
- `language` — xAI only (BCP-47 hint).
- `format` — only meaningful for cloud providers writing audio files.

Storing them on apps that don't use them is harmless — the relevant provider just ignores them.

---

## Saving (`--save`)

`--save` persists the flags **explicitly passed on this invocation** to the `--app` profile. Other fields are left alone.

```bash
# Save voice + provider for the "claude" profile
tools say --app claude --voice Samantha --provider macos --save

# Save only volume — voice/provider untouched
tools say --app claude --volume 0.5 --save

# Save-and-speak: speaks first, persists after success
tools say "deploy done" --app claude --voice Samantha --save
```

Rules:

- **`--save` requires `--app <name>`.**
  - Non-TTY (no terminal): hard error with the suggested form.
  - TTY: prompts you to pick an existing profile or create a new one (the `default` name is reserved).
- **Save-only invocation:** if `--save` is set and **no message text** is supplied (no positional args, no `--file`), nothing is spoken — only config is written.
- **Save-and-speak:** if a message is supplied, the speech runs first, then config is persisted only on success.
- **Only the flags you typed get saved.** Unspecified flags do not overwrite existing profile values.
- **Volume is normalized:** `--volume 50%` and `--volume 0.5` both store as `0.5`.

---

## Unsetting fields (`--unset`)

`--unset <fields>` takes a comma-separated list of profile fields to clear. It works in two modes:

```bash
# Ephemeral: ignore the saved voice for this single run
tools say "test" --app claude --unset voice

# Persisted: remove the voice key from the saved profile
tools say --app claude --unset voice --save

# Multiple fields at once
tools say --app claude --unset voice,volume,provider --save
```

Valid field names: `voice`, `volume`, `provider`, `rate`, `model`, `format`, `language`, `mute`.

With `--save`, the keys are reset to `null` (not deleted), so the profile keeps the full schema visible while the resolution chain falls through to the `default` profile.

---

## Mute / unmute

`--mute` and `--unmute` are now `--save`-dependent. Without `--save` they error — they no longer write config implicitly.

```bash
# Mute the "claude" profile (persisted)
tools say --app claude --mute --save

# Unmute it
tools say --app claude --unmute --save

# Toggle global mute interactively
tools say config   # → "Toggle global mute"
```

Without `--save`:

```bash
$ tools say --app claude --mute
[say] --mute / --unmute now require --save to persist.
```

---

## Interactive config (`tools say config`)

`tools say config` (or just `tools say` with no args) opens the same clack-driven manager:

- **Speak text (test)** — pick a profile, type something, hear it
- **Edit an app profile** — pick an existing app or `+ new app`; walks every field once (⏎ keep, `-` inherit, value to set), summary, confirm
- **List** apps with their resolved (post-inherit) settings
- **Delete** an app (the `default` profile is non-removable)
- **List available voices**
- **Toggle global mute**

In a non-TTY context both entry points fail fast — pass `--app <name> --save` (or `<message>`) instead.

---

## All options

| Option | Description |
|--------|-------------|
| `[message...]` | Text to speak (positional, joined with spaces) |
| `--volume <n>` | Volume `0.0-1.0` or `0-100%` |
| `--voice [name]` | Voice id; pass without value to list available voices |
| `--rate <n>` | Speed: `0..2` multiplier or `0..200%` (`1` = default). Matched across providers. |
| `--wait` | Block until speech finishes |
| `--app <name>` | App profile to load; required target for `--save` |
| `--mute` | Mute the app (requires `--save`) |
| `--unmute` | Unmute the app (requires `--save`) |
| `--provider <name>` | TTS backend: `macos`, `xai`, `openai` |
| `--language <bcp47>` | Language hint (xAI) |
| `--format <codec>` | `mp3` or `wav` |
| `--file <path>` | Read text from a file |
| `--stream` / `--no-stream` | Force streaming mode on/off |
| `--model <id>` | Provider-specific model (OpenAI: `tts-1`, `gpt-4o-mini-tts`) |
| `--save` | Persist explicitly-passed flags to `--app`'s profile |
| `--unset <fields>` | Comma-separated profile fields to ignore (or remove with `--save`) |

Subcommands:

- `tools say voices` — list voices grouped by provider
- `tools say models` — list downloadable TTS models
- `tools say config` — interactive profile manager

---

## Migration from v1

The first time the new build runs against a v1 config (the old `defaultVoice` / `defaultVolume` / `globalMute` / `appMute` / `appVolume` shape), it migrates lazily:

- `defaultVoice` / `defaultVolume` → `apps[default].voice` / `.volume`
- `globalMute` → `global.mute`
- Each name in `appMute ∪ appVolume` → its own profile entry, with the v1 mute and volume preserved.

Before the first overwrite, the original v1 file is copied to `~/.genesis-tools/say/config.v1.bak.json` (only if no backup already exists). To roll back, restore that file over `config.json`.

---

## Programmatic use

```ts
import { speak } from "@app/utils/macos/tts";

await speak("Build done", { app: "build" }); // resolves the "build" profile
```

For full config CRUD:

```ts
import { SayConfigManager } from "@app/utils/macos/SayConfigManager";

const mgr = new SayConfigManager();
await mgr.patchApp("claude", { voice: "Samantha", provider: "macos" });
await mgr.unsetAppFields("claude", ["volume"]);
const effective = await mgr.resolveApp("claude"); // merged with default
```
