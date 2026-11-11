# tools loc

> **Count files and code, blank and comment lines by language, respecting `.gitignore`.**

A `cloc` replacement that already knows to skip `node_modules`, `.git` and anything your `.gitignore` excludes, so the
number it prints is the number you meant.

---

## Quick start

```bash
tools loc                              # current directory
tools loc src/                         # one subtree
tools loc --top 10                     # only the 10 largest languages
tools loc --by ext                     # group by file extension instead of language
tools loc --include-hidden             # count dotfiles and dot-directories too
tools loc --json                       # exact numbers, one line of JSON
```

## Arguments and options

`tools loc` has no subcommands. It is one command:

| Item | Description |
|------|-------------|
| `[dir]` | Directory to scan (default: `.`). A file is refused. |
| `--top <n>` | Show only the top N rows by code lines. `n` is a whole number, 1 or more. |
| `--by <key>` | Group rows by `lang` or `ext` (default: `lang`) |
| `--json` | Emit the report as JSON instead of a table |
| `--no-gitignore` | Do not honour `.gitignore`. It still skips `.git`, `node_modules` and dotfiles. |
| `--include-hidden` | Include dotfiles and dot-directories |
| `-v, --verbose` | Debug lines on stderr: file count, skipped paths |
| `--readme` | Print this file and exit |
| `-h, --help` | Print the option list |

---

## What gets scanned

The walk starts at `[dir]` and goes down every folder. It checks each entry in this order:

1. A file or folder named `.git` or `node_modules`, at any depth inside `[dir]`, is skipped.
2. A name that starts with `.` is skipped, unless you pass `--include-hidden`.
3. A path that a `.gitignore` excludes is skipped, unless you pass `--no-gitignore`.
4. A symbolic link is skipped, to a file or to a folder.
5. A file with a NUL byte in its first 8 KB is binary. It is skipped and does not count as a file. A UTF-16 text
   file has NUL bytes too, so it is skipped as binary.
6. A file or folder it cannot read is skipped without an error. `-v` names it.

The `[dir]` you pass is always scanned, even when its own name starts with a dot or is `node_modules`. `tools loc .github` counts the
workflows without `--include-hidden`, and `tools loc node_modules/left-pad` counts one dependency. Only the dot-named
entries inside it are skipped.

### The two exclusion flags, together

They control different things, so combining them is meaningful:

| Invocation | What is counted |
|------------|-----------------|
| (default) | `.gitignore` is honoured, dotfiles are skipped |
| `--no-gitignore` | `.gitignore` rules are ignored, so build output and caches count. Dotfiles are still skipped. |
| `--include-hidden` | Dotfiles and dot-directories count. `.gitignore` is still honoured. |
| both | Everything except `.git`, `node_modules`, links and binary files |

**`.git` and `node_modules` are excluded whichever flags you pass.** Counting them is never what you wanted, and
walking them is slow.

### How `.gitignore` is read

`tools loc` does not call git. It reads `.gitignore` files with git's pattern rules (through the `ignore` package), so
it also works in a folder that is not a repository. A `.gitignore` in a subfolder applies to that folder and below, as
in git. It differs from git in four ways:

- **Only `.gitignore` files inside `[dir]` count.** A `.gitignore` in a parent folder is not read. So `tools loc src/`
  does not apply the repository root's `.gitignore`, and a `dist/` folder under `src/` that the root file hides is
  counted.
- `.git/info/exclude` and your global excludes file (`core.excludesFile`) are not read.
- It counts what `.gitignore` allows, not what git tracks. A tracked file that matches a pattern (one added with
  `git add -f`) is skipped, and an untracked file that matches no pattern is counted.
- A `!pattern` in a nested `.gitignore` cannot bring back a file that a parent `.gitignore` excludes. Each path is
  checked against every `.gitignore` above it, and any match skips it.

---

## How lines are counted

Each line is classified as code, blank or comment:

- **Blank**: the line is empty or holds only whitespace.
- **Comment**: the line holds comment markers and nothing else. Comment detection is per language, so a `#` line in
  Python and a `//` line in TypeScript are both comments, while a `#` line in TypeScript or Markdown is code.
- **Code**: every other line. A line with code and a trailing comment (`let y = 2; // note`) is code. So is a line with
  code before a `/*` or after a `*/`.

The non-blank lines between a block comment's open and close markers are comments. A blank line inside a block still
counts as blank. The final newline of a file does not add a
blank line. An empty file has zero lines but still counts as one file. `Lines` is code plus comment plus blank.

### Languages and their comment markers

The language comes from the file extension: the text after the last dot, lowercased. A file without a dot uses its
whole name, so `Makefile` is Makefile and `Dockerfile` is Docker.

- `//` and `/* */`: TypeScript (`ts`, `tsx`), JavaScript (`js`, `jsx`, `mjs`, `cjs`), Go, Rust (`rs`), Java,
  Kotlin (`kt`), C (`c`, `h`), C++ (`cpp`, `cc`, `hpp`), C# (`cs`), Swift, PHP, SCSS, Sass, Less, Prisma,
  Protobuf (`proto`), and `jsonc`, which groups as JSON
- `//`, `/* */` and `<!-- -->`: Vue, Svelte
- `/* */` only: CSS
- `<!-- -->`: HTML (`html`, `htm`), Markdown (`md`, `mdc`), XML, SVG
- `#`: Python (`py`), Ruby (`rb`), Shell (`sh`, `bash`, `zsh`), YAML (`yaml`, `yml`), TOML, GraphQL (`graphql`,
  `gql`), NEON, Docker (`dockerfile`), Makefile
- `#` and `;`: INI (`ini`, `conf`, `env`)
- `--`: SQL, Lua
- `{# #}`: Twig
- `{{-- --}}` and `<!-- -->`: Blade (`blade`)
- No comment markers, so every non-blank line is code: JSON (`json`), Text (`txt`, `log`), Lock (`lock`), CSV,
  Stub (`stub`)

Any other extension groups as **Other**. It has no comment markers, so all its non-blank lines count as code.

`--by ext` is the escape hatch for files the language table does not know. Grouping by extension always works, even
for a file type that folds into Other. It does not add comment rules: such a file still counts every non-blank line
as code.

### Known limits

The classifier looks for markers. It does not parse the language. Each of these follows from the code and was checked
against the classifier:

- **It does not know about strings.** A `/*` inside a string opens a block comment. After `const g = "src/*.ts";`, the
  next lines count as comments until a `*/` appears. A `//` inside a string on a line that already holds code is
  harmless. A line inside a multi-line string or template literal that starts with `//` (or with `#` in Python) counts
  as a comment.
- Python docstrings (`"""..."""`) count as code.
- A shebang (`#!/bin/sh`) in a `#` language counts as a comment.
- Only the first line of a Lua `--[[ ]]` block counts as a comment. SQL `/* */` blocks count as code.
- PHP `#` comments count as code.
- The last dot decides the language: `view.blade.php` is PHP, `types.d.ts` is TypeScript, `Dockerfile.dev` is Other,
  and `.env.local` is Other.

---

## Output

### The table

One row per language (or per extension with `--by ext`), then a `Total` row. The columns are `Language` (or `Ext`),
`Files`, `Lines`, `Code`, `Comment` and `Blank`. Rows are sorted by code lines, largest first. A tie goes to the row
with more lines, then to the name in alphabetical order.

- **The table rounds.** A number from 1,000 up prints as `12.3K`, `4.5M` or `1.2B`. Use `--json` for exact counts.
- `--top <n>` cuts rows after the sort, but `Total` still counts every file. So the rows shown do not add up to the
  total.
- With `--by ext`, a file without a dot shows its whole lowercased name (`makefile`, `license`). A name that ends in a
  dot shows as `(no ext)`.

### JSON

`--json` prints one line of JSON on stdout, with exact numbers. Pretty-printed, it looks like this:

```json
{
  "root": "/path/to/app",
  "by": "lang",
  "generatedAt": "2026-06-02T00:52:00.000Z",
  "rows": [
    { "name": "TypeScript", "files": 2, "lines": 172, "code": 150, "comment": 15, "blank": 7 }
  ],
  "total": { "files": 2, "lines": 172, "code": 150, "comment": 15, "blank": 7 }
}
```

`root` is the absolute path of `[dir]`. `generatedAt` is UTC. `by` is `lang` or `ext`, and each row's `name` is then a
language or an extension. `rows` follows the table order and `--top`. `total` always covers every file.

---

## How it works

`tools loc` stores nothing of its own and has no config file, no environment variables and no account. It walks the
folder, reads each file (50 at a time), classifies its lines and adds them up. Like every tool, it writes its log
lines to the shared day log, `~/.genesis-tools/logs/<date>.log`. The day log keeps the debug lines (each skipped
binary or unreadable path) even when you did not pass `-v`.

It needs no permission of its own. A folder that macOS privacy protects (`~/Documents`, `~/Downloads`, `~/Desktop`)
can be unreadable from your terminal, and the walk then skips it without an error.

## For agents

- Use `--json`. It is the stable interface. The table layout is for humans and may change.
- stdout carries only the report. Errors and `-v` lines go to stderr.
- Exit code 0 on success, also for an empty folder (no rows and a zero total).
- Exit code 1 when `[dir]` is missing or not a directory (`Not a directory: <path>`), when `--top` is not a whole
  number of 1 or more, or when `--by` is not `lang` or `ext`.
- `tools loc --json | tools json` converts the report to TOON when that is smaller, so it costs fewer tokens in a
  prompt.

## Troubleshooting

**A subfolder scan counts build output.** You ran `tools loc src/`, and the ignore rule lives in the repository root's
`.gitignore`, which the scan does not read. Scan the folder that holds the `.gitignore`. No flag reads parent
`.gitignore` files.

**TypeScript or JavaScript shows too many comment lines.** A `/*` inside a string, often a glob such as `"src/*.ts"`,
opened a block comment. Treat that language's split between code and comment as an estimate. Its `Lines` and `Blank`
counts are still exact.

**`.github`, `.claude` or `.env` files are missing.** Dot-directories and dotfiles are skipped by default. Pass
`--include-hidden`, or pass the folder itself: `tools loc .github`.

**Generated or vendored files are counted.** They match no `.gitignore` rule, or only a rule in `.git/info/exclude`
or your global excludes file. Add the pattern to a `.gitignore` inside the scanned folder.

**Fewer files than you expected, and no error.** The walk skipped binary files (UTF-16 text included), symbolic links,
or folders it could not read. Run with `-v` to see each binary file and each unreadable file or folder. Links and
ignored paths are skipped without a log line.

**The numbers in the table look rounded.** They are: `12.3K` means about 12,300. Use `--json`.

**`Not a directory`** for a file path. `tools loc` scans folders only. Pass the folder that holds the file.

## Related

- [`tools json`](../json/README.md): convert the `--json` report to TOON.
- [`tools ts`](../ts/README.md): `tools ts refactors` ranks what to refactor in a TypeScript tree, such as long
  functions.
- [`tools du`](../du/README.md): disk usage on APFS, when you need bytes instead of lines.
