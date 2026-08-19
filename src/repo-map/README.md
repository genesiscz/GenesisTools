# tools repo-map

> **Token-efficient repo symbol map for agents, in the style of aider.**

Hands an agent the shape of a codebase (which files matter, and what each declares) inside a token budget, instead of making it read files to find out.

---

## Quick start

```bash
tools repo-map                                  # current directory, 8000-token budget
tools repo-map src/                              # one subtree
tools repo-map --max-tokens 2000                 # tighter budget
tools repo-map --lang ts,tsx                     # only these languages
tools repo-map --files-only                       # ranked file list, no symbols
tools repo-map --json | tools json               # structured output
tools repo-map --clipboard                        # straight into a prompt
```

## Arguments and options

| Item | Description |
|------|-------------|
| `[dir]` | Directory to map (default: `.`) |
| `--max-tokens <n>` | Token budget for the rendered map (default: 8000) |
| `--lang <list>` | Restrict to languages, comma-separated and repeatable |
| `--json` | Emit structured JSON instead of a tree |
| `--files-only` | List ranked files without per-file symbols |
| `--clipboard` | Copy the rendered map to the clipboard |
| `-v, --verbose` | Enable verbose logging |
| `--readme` | Print this file and exit |

---

## What the budget buys

The map is ranked, not truncated alphabetically. Files that more of the codebase depends on rank higher, so when the budget runs out, what gets dropped is the leaf nobody imports rather than the module everything routes through.

That is why `--max-tokens` is the main dial. At 2000 tokens you get the spine of the project. At 8000 you get most declarations. Raising it past what the agent will actually read wastes context.

`--files-only` is the cheapest useful output: which files matter, in rank order, with no symbol detail. Good as a first step before deciding what to read properly.

## Notes

- This is a map, not a search index. For semantic search over content, use [`tools indexer`](../indexer/README.md).
- For dumping actual file contents into a prompt, use [`tools files-to-prompt`](../files-to-prompt/README.md). `repo-map` deliberately gives you names and structure only.
