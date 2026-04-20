# Cursor Context

![Status](https://img.shields.io/badge/Status-Active-success?style=flat-square)

> **Strip tool-use parameters and/or results from SpecStory exports to save tokens.**

Cursor's SpecStory logs embed every tool call and its full output inline. When you want to feed such a log back into an LLM (or just read it), those blocks balloon the token count. `cursor-context` parses the log, lets you pick which tools' **inputs** and/or **outputs** to strip, and copies the cleaned result to your clipboard.

---

## Quick Start

```bash
# Interactive — pick which tools to strip
tools cursor-context logs/story.log

# Default path (logs/story.log) + save to a file
tools cursor-context -o cleaned.log

# Explicit input and output files
tools cursor-context -i my-story.log -o my-story.cleaned.log
```

---

## Options

| Option | Alias | Description |
|--------|-------|-------------|
| `[file]` | — | Path to the SpecStory file (default: `logs/story.log`) |
| `--input <file>` | `-i` | Input SpecStory file path |
| `--output <file>` | `-o` | Output file path (omit to only copy to clipboard) |
| `--help-full` | `-?` | Extended help |

---

## How it works

1. Parses every `<tool-use data-tool-name="...">...</tool-use>` block and locates `Parameters:` / `Result:` / `Status:` sections.
2. Shows a checkbox prompt with one line per tool for **input** and **output** — toggle what you want removed.
3. If a tool has both input and output selected, the entire block is stripped.
4. Collapses any runs of 3+ blank lines to 2 so the cleaned log stays readable.
5. Copies the result to the clipboard. If `--output` wasn't passed, optionally asks for a path.

---

## Typical use case

A long Cursor conversation with a lot of `read_file` or `grep` blocks. Strip the results (keep the parameters so you still see what was asked) — token count usually drops by 50-80%.
