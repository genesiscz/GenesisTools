# JSON Schema

![Status](https://img.shields.io/badge/Status-Active-success?style=flat-square)

> **Infer schemas from JSON data — skeleton, TypeScript interfaces, or standard JSON Schema.**

Feed it a JSON file (or pipe via stdin) and get back a compact view of its structure. Handy for understanding API responses before you touch them, especially paired with `har-analyzer` / `github get` for captured payloads.

---

## Quick Start

```bash
# From a file
tools json-schema data.json

# From stdin
curl -s https://api.example.com/users | tools json-schema

# As TypeScript interfaces
tools json-schema data.json -m typescript

# As a JSON Schema document
tools json-schema data.json -m schema

# Multi-line (pretty) output + copy to clipboard
tools json-schema data.json -m typescript --pretty --clipboard
```

---

## Output Modes

| Mode | Flag | Example Output |
|------|------|----------------|
| **Skeleton** (default) | `-m skeleton` | `{ users: { id: integer, name: string }[], total: integer }` |
| **TypeScript** | `-m typescript` | `interface User { id: number; name: string }` |
| **JSON Schema** | `-m schema` | Standard JSON Schema object |

---

## Options

| Flag | Alias | Description | Default |
|------|-------|-------------|---------|
| `[file]` | — | JSON file to analyze (omit to read stdin) | stdin |
| `--mode <mode>` | `-m` | `skeleton`, `typescript`, or `schema` | `skeleton` |
| `--pretty` | `-p` | Multi-line indented output | compact |
| `--clipboard` | `-c` | Copy output to clipboard | off |

---

## Smart Features

- **Arrays:** Merges every item into one unified schema so heterogeneous arrays are collapsed cleanly.
- **Optional fields:** Marks fields as optional (`?`) when they're absent in some array elements.
- **TypeScript naming:** Singularizes parent array names (`users -> User[]`, `categories -> Category[]`).
- **Compact by default:** One interface per line — add `--pretty` for multi-line formatting.

---

## Notes

The actual inference happens in `@app/utils/json-schema` (`inferSchema`, `formatSchema`) so the same logic is reused by `har-analyzer`'s `expand --schema`.
