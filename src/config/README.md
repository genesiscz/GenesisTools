# tools config

> **Manage GenesisTools configuration.**

A small front end for the settings that are global to the toolkit rather than owned by one tool. Today that means optional package preferences.

---

## Commands

| Command | Description |
|---------|-------------|
| `packages` | Manage optional package installation preferences |

## Quick start

```bash
tools config packages       # review and change optional package preferences
tools config --readme       # print this file
```

---

## Why optional packages exist

Some tools depend on heavy or platform-specific packages that most users never need: local ONNX runtimes, native vector search, browser automation. Rather than install everything for everyone, those packages are optional. `tools config packages` records which ones you want, so a tool that needs one can install it on demand instead of prompting every run.

Per-tool configuration does **not** live here. Each tool owns its own file under `~/.genesis-tools/<tool>/`, for example `~/.genesis-tools/say/config.json`. AI accounts and credentials live under `~/.genesis-tools/ai/` and the encrypted vault at `~/.genesis-tools/security/vault.json`.
