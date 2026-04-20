# Say

![Status](https://img.shields.io/badge/Status-Active-success?style=flat-square)
![Platform](https://img.shields.io/badge/Platform-macOS-blue?style=flat-square)

> **Text-to-speech with volume control, auto language detection, and per-app mute.**

A macOS `say` wrapper that remembers per-app volume and mute state, auto-picks a voice for the detected language, and supports both one-shot speech and an interactive prompt mode.

---

## Key Features

| Feature | Description |
|---------|-------------|
| **Per-app mute** | `--app <name>` scopes mute/unmute and volume to a caller identity |
| **Auto voice/lang** | Voice is picked from the text's language if not overridden |
| **Volume units** | `--volume 0.6` or `--volume 60%` — both work |
| **Blocking mode** | `--wait` blocks until speech finishes (useful in scripts) |
| **Interactive mode** | `tools say` with no args opens a prompt |

---

## Quick Start

```bash
# One-shot
tools say "Build finished"

# From another tool (mute-able per app)
tools say "Timer done" --app timer --wait

# Mute all say output from one caller
tools say --mute --app claude
tools say --unmute --app claude

# Change the voice for a run
tools say "Hola amigo" --voice Paulina
```

---

## Options

| Option | Description |
|--------|-------------|
| `[message...]` | Text to speak (positional, joined with spaces) |
| `--volume <n>` | Volume `0.0-1.0` or `0-100%`; persisted per-app when `--app` is set |
| `--voice <name>` | Override the macOS voice |
| `--rate <wpm>` | Words per minute |
| `--wait` | Block until speech finishes |
| `--app <name>` | Caller identity for per-app mute/volume |
| `--mute` | Mute globally, or per-app with `--app` |
| `--unmute` | Unmute globally, or per-app with `--app` |

---

## Examples

Scripting (e.g. a build finished in the background):

```bash
long-build && tools say "Build done" --app build-scripts --wait
```

Silence just one caller without touching global settings:

```bash
tools say --mute --app timer    # timer stays quiet
tools say "Still speaking"       # other callers still work
```

Interactive voice picker:

```bash
tools say
```
