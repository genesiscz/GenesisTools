# tools loc

> **Count files and code, blank and comment lines by language, respecting `.gitignore`.**

A `cloc` replacement that already knows to skip `node_modules`, `.git` and anything your `.gitignore` excludes, so the number it prints is the number you meant.

---

## Quick start

```bash
tools loc                              # current directory
tools loc src/                         # one subtree
tools loc --top 10                     # only the 10 largest languages
tools loc --by ext                     # group by file extension instead of language
tools loc --json | tools json          # machine-readable
tools loc --include-hidden             # count dotfiles too
tools loc --no-gitignore               # ignore .gitignore rules
```

## Arguments and options

| Item | Description |
|------|-------------|
| `[dir]` | Directory to scan (default: `.`) |
| `--top <n>` | Show only the top N rows by code lines |
| `--by <key>` | Group rows by `lang` or `ext` (default: `lang`) |
| `--json` | Emit the report as JSON instead of a table |
| `--no-gitignore` | Do not honour `.gitignore`. It still skips `.git`, `node_modules` and dotfiles. |
| `--include-hidden` | Include dotfiles and dot-directories |
| `-v, --verbose` | Enable verbose logging |
| `--readme` | Print this file and exit |

---

## What counts as what

Each line is classified as code, blank or comment. Comment detection is per language, so a `#` line in Python and a `//` line in TypeScript are both comments, while a `#` inside a TypeScript string is not a comment.

`--by ext` is the escape hatch for files the language table does not know. Grouping by extension always works, even for a file type the tool has no comment rules for.

## Notes

- Even with `--no-gitignore`, `.git` and `node_modules` stay excluded. Counting them is never what you wanted, and walking them is slow.
- `--json` is the stable interface. The table layout is for humans and may change.
