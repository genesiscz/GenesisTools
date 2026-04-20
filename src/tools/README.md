# Tools Browser

![Status](https://img.shields.io/badge/Status-Active-success?style=flat-square)

> **Interactive launcher for every GenesisTools command.**

`tools tools` (or running `tools` with no arguments) opens a searchable picker of every tool in `src/`. Select a tool and choose to run it, view its README, explore its subcommands, or copy its command string to the clipboard.

---

## Quick Start

```bash
# Open the interactive browser (no args)
tools

# Same thing, explicitly
tools tools
```

---

## Actions per tool

| Action | Description |
|--------|-------------|
| **Run** | Launches `tools <name>` in the current terminal |
| **View README** | Renders `src/<name>/README.md` with the bundled markdown renderer |
| **Explore subcommands** | Introspects the tool's Commander graph and lets you pick a subcommand |
| **Copy command** | Copies `tools <name>` (or a full subcommand) to your clipboard |
| **Back** | Returns to the tool list |

---

## How it works

- `discoverTools()` scans `src/` for directories with `index.ts` / `index.tsx` and standalone `.ts` / `.tsx` files.
- `getReadme()` reads `src/<name>/README.md` if present.
- `introspectTool()` runs `bun run <path> --help` to extract subcommands and options.
- The picker uses the shared `searchSelect` clack widget for fuzzy-matching.

The browser never modifies anything — it's pure discovery and dispatch.
