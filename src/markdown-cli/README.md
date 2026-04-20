# Markdown CLI

![Status](https://img.shields.io/badge/Status-Active-success?style=flat-square)

> **Render markdown to beautiful CLI output, with watch mode and theme support.**

A thin wrapper around the shared `utils/markdown` renderer used across GenesisTools. Handy when you want to preview a markdown file in the terminal without opening an editor, or live-reload a doc while editing it.

---

## Quick Start

```bash
# Render a file
tools markdown-cli README.md

# Pipe from stdin
cat README.md | tools markdown-cli

# Watch a file and re-render on save
tools markdown-cli README.md --watch

# Constrain width + light theme
tools markdown-cli README.md --width 80 --theme light

# Strip ANSI color (great for piping)
tools markdown-cli README.md --no-color > plain.txt
```

---

## Options

| Option | Alias | Description | Default |
|--------|-------|-------------|---------|
| `[file]` | — | Markdown file (or pipe via stdin) | — |
| `--watch` | `-w` | Watch the file and re-render on change | off |
| `--width <n>` | — | Max output width in columns | terminal |
| `--theme <name>` | — | `dark`, `light`, or `minimal` | `dark` |
| `--no-color` | — | Strip ANSI color codes | off |

---

## Notes

- Watch mode uses `chokidar` and clears the screen on each re-render.
- Stdin mode is auto-detected (non-TTY stdin) and overrides the `[file]` argument.
- The renderer is the same one used by the interactive `tools` browser, so output is consistent with how READMEs appear inside the picker.
