# tools envdiff

Compare a project's `.env` with its `.env.example` and list the keys that are missing, extra or changed, with values
masked by default. Run it after a `git pull` that touched `.env.example`, and in CI before a deploy discovers the
missing key for you. `--sync` appends the missing keys to `.env` so you only have to fill in their values.

## Quick start

```bash
tools envdiff                                   # .env vs .env.example in this directory
tools envdiff apps/api                          # the same, in another directory
tools envdiff .env.production .env.example      # two explicit files
tools envdiff --show-values                     # reveal values instead of masking them
tools envdiff --sync                            # append the missing keys to .env
tools envdiff --check-values                    # also fail on changed values
```

## Commands

`envdiff` is one command with no subcommands.

```text
tools envdiff [options] [dir]
tools envdiff [options] <actualFile> <exampleFile>
```

| Argument or option   | What it does                                                 |
|----------------------|--------------------------------------------------------------|
| `[dir]`              | Compare `<dir>/.env` with `<dir>/.env.example`. Default: `.` |
| `<actual> <example>` | Compare these two files, in this order.                      |
| `--actual <path>`    | The actual env file. Default: `<dir>/.env`.                  |
| `--example <path>`   | The reference file. Default: `<dir>/.env.example`.           |
| `--show-values`      | Print values in the text report instead of `••••••`.         |
| `--sync`             | Append the missing keys to the actual file.                  |
| `--check-values`     | Also exit 1 on a changed value.                              |
| `--json`             | Print the diff as one line of JSON.                          |
| `-v, --verbose`      | Enable verbose logging.                                      |
| `--readme`           | Print this file and exit.                                    |

How the paths resolve:

- No positional: `./.env` and `./.env.example`.
- One positional is always a directory. `tools envdiff .env.local` looks for `.env.local/.env.example` and fails
  with exit 2. To compare one other file against the default example, use `--actual .env.local`.
- Two positionals are the actual file and the example file. A third one is a usage error (exit 2), which is what an
  unquoted `.env*` glob turns into.
- `--actual` and `--example` win over the positionals and are used as written, relative to the current directory.
  `tools envdiff apps/api --example .env.sample` reads `./.env.sample`, not `apps/api/.env.sample`.

The exit code is the verdict: 0 when the keys match, 1 on drift, 2 when `envdiff` could not compare. See
[Exit codes](#exit-codes) for the details and a CI gate.

### What the report shows

Given this `.env`:

```bash
DATABASE_URL=postgres://localhost/app_dev
API_KEY=sk-local-123
LOCAL_DEBUG=1
PORT=3000
```

and this `.env.example`:

```bash
DATABASE_URL=postgres://localhost/app
API_KEY=changeme
PORT=3000
REDIS_URL=redis://localhost:6379
```

`tools envdiff .env .env.example` prints this and exits 1:

```text
envdiff  .env  vs  .env.example
  Missing in .env (1)
    + REDIS_URL = ••••••  (example value)
  Extra in .env (1)
    - LOCAL_DEBUG
  Changed (2)
    ~ DATABASE_URL  •••••• ≠ ••••••
    ~ API_KEY  •••••• ≠ ••••••
  In sync (1 keys)

Drift: 4 differences. Run `tools envdiff --sync` to add the missing keys.
```

- **Missing** keys are in the example and not in your file. The value shown is the example's value. They are listed
  in the example's order.
- **Extra** keys are in your file and not in the example. They are listed in your file's order.
- **Changed** keys are in both files with different values. A real `.env` holds secrets where the example holds
  placeholders, so a changed value is expected and does not fail the run unless you pass `--check-values`.
- The `Drift` count adds up all three groups, changed values included, even when they do not fail the run.
- When nothing differs, the report is the header and one `In sync (N keys)` line that says there is no drift.
- Values are compared after parsing, so `KEY="value"`, `KEY='value'` and `KEY=value` are the same value.

Values are masked by default, so the output is safe to paste into an issue or a CI log. `--show-values` is opt-in for
a reason. The mask is always six dots, whatever the value's length, so it does not leak how long a secret is. An empty
value prints as empty, so a key with no value is visible without `--show-values`. Colors appear only when stdout is a
terminal and `--json` is off.

"Extra" keys are not errors in every project. A local `.env` often carries machine-specific settings the example does
not list, and they still make the run exit 1. Read the report before you treat a non-zero exit as a defect.

### Sync the missing keys

`--sync` writes to your actual env file. It only appends the keys that are missing, and it never edits or reorders a
key you already set, so an existing secret cannot be clobbered. Each appended key gets the example's placeholder
value, which you then have to fill in. With the files above, `tools envdiff --sync .env .env.example` prints:

```text
Synced 1 keys into .env:
    + REDIS_URL
```

and appends a dated block to `.env` (the time is UTC):

```bash
PORT=3000

# --- synced by tools envdiff @ 2026-11-09T10:00:00.000Z ---
REDIS_URL=redis://localhost:6379
```

- A value with a space, `#`, a quote or a backslash is written in double quotes with `"` and `\` escaped, so it reads
  back as the same value.
- A file without a final newline gets one before the block. An empty or missing file gets the block without the
  blank line in front.
- When no key is missing, `--sync` says so and does not touch the file.
- `--sync` exits 0 once the write succeeds, even when extra keys remain. The next plain run still reports them. It
  prints the short summary above, never the diff: `--json`, `--check-values` and `--show-values` have no effect on
  it.
- The write is atomic (a temporary file, then a rename). An existing file keeps its permissions, and a symlinked
  `.env` is written through to the file it points to. A read-only `.env` fails with exit 2 and is not changed.
- When the actual file does not exist, `--sync` creates it, and its folder if needed. A new file gets your umask's
  default permissions (usually `644`, readable by other users), so run `chmod 600 .env` when it holds secrets.

## How it works

`envdiff` reads two files and prints a report. It has no config file and stores no data of its own. Like every
tool, a run that exits non-zero is recorded in the shared logs under `~/.genesis-tools/logs/`. It makes no network
calls and needs no macOS permission. Only `--sync` changes one of your files, and only the actual env file.

When the actual file is missing, it prints `Actual file not found (<path>); treating as empty.` on stderr and
compares an empty file, so every example key shows as missing. When the example file is missing, it exits 2.

The parser reads one line at a time and keeps only the lines that look like `KEY=value`:

- A key starts with a letter or `_` and holds letters, digits and `_`. A line with any other key (`my.key=1`,
  `my-key=1`) is ignored without a warning, in both files, so `envdiff` never reports that key.
- An `export ` prefix is allowed, and spaces around the key, the `=` and an unquoted value are trimmed.
- Blank lines, lines without `=` and full-line `#` comments are ignored.
- In an unquoted value, the first `#` starts a comment, even with no space before it: `COLOR=#336699` reads as an
  empty value. Quote a value that contains `#`.
- A double-quoted value ends at the closing quote, and only `\"` and `\\` are unescaped. `\n` stays two characters.
  A single-quoted value is taken literally. A comment after the closing quote is fine.
- `${OTHER}` references are not expanded, and a value that spans several lines keeps only its first line.
- When a key appears twice, the last value wins and the key keeps its first position.

## For agents

- `--json` prints one line of JSON on stdout. Warnings and errors go to stderr, so stdout stays parseable.
- `tools envdiff --json | tools json` prints the same data as TOON when that is smaller, so an agent reads fewer
  tokens.
- The exit code is the verdict (see [Exit codes](#exit-codes)). `--json` follows the same rules, including
  `--check-values`.
- The JSON never holds a value from your actual file. `missing[].exampleValue` is the example's value, unmasked,
  whatever `--show-values` says. `extra` and `changed` list keys only.

The shape, shown pretty-printed for the files above:

```json
{
    "actual": ".env",
    "example": ".env.example",
    "missing": [{ "key": "REDIS_URL", "exampleValue": "redis://localhost:6379" }],
    "extra": [{ "key": "LOCAL_DEBUG" }],
    "changed": [{ "key": "DATABASE_URL" }, { "key": "API_KEY" }],
    "inSyncCount": 1,
    "driftCount": 4
}
```

`actual` and `example` are the resolved paths. A path from `--actual`, `--example` or two positionals is used as
typed. A default path is the directory joined with `.env` or `.env.example`, so `tools envdiff apps/api` gives
`apps/api/.env`. It is absolute when you pass no positional, because the directory is then the current directory.
The text report header uses the same paths. There is no MCP tool and no plugin skill for `envdiff`.

### Exit codes

| Code | Meaning                                                              |
|------|----------------------------------------------------------------------|
| `0`  | The two files have the same keys. Also every successful `--sync`.    |
| `1`  | A key is missing or extra, or a value changed with `--check-values`. |
| `2`  | `envdiff` could not compare (see below).                             |

Exit 2 means `envdiff` could not compare: more than two positionals, no example file, a file it cannot read, or a
`--sync` write that failed. The message is on stderr.

A command-line error that the parser catches (an unknown flag such as `--check-value`, or a flag with no value such
as a bare `--actual`) exits 1, the same code as drift. It prints `error: unknown option …` or
`error: option … argument missing` on stderr, then the help. Read stderr to tell them apart.

A CI step that runs the bare command fails on any non-zero exit, so `tools envdiff` alone is a usable gate. To add a
message, keep the failure:

```bash
tools envdiff || { echo "envdiff failed, see above"; exit 1; }
```

Use the code itself when the gate must tell drift from a setup that `envdiff` could not compare. Capture the code
with `|| rc=$?`, so a shell with `set -e` (such as a GitHub Actions `run:` step) does not stop at the first line:

```bash
rc=0
tools envdiff || rc=$?
case $rc in
    0) ;;
    1) echo "env drift, or a mistyped flag: see stderr above"; exit 1 ;;
    *) echo "envdiff could not compare, see stderr above"; exit 2 ;;
esac
```

## Troubleshooting

- **`Example file not found: …/.env.example`, exit 2.** The directory has no example file, or you passed one file
  name as the only argument and it was read as a directory. Pass `--example <path>`, or both files as two
  positionals.
- **`Expected at most 2 positional arguments`, exit 2.** You passed three or more paths, often an unquoted `.env*`
  glob. Name the two files.
- **`error: unknown option`, exit 1.** A mistyped flag exits 1, the same code as drift. Check the flag against the
  table in [Commands](#commands).
- **Every example key shows as missing.** The actual file does not exist: look for `Actual file not found` on stderr.
  Check the path, or run `--sync` to create the file.
- **A key is missing although it is in the file.** The line is not a plain `KEY=value` line: it uses `KEY: value`,
  has no `=`, or starts with a word other than `export`. The parser skips such lines without a warning.
- **A value shows as changed although it looks the same.** An unquoted `#` cut the value short on one side. Quote
  the value in both files.
- **`Failed to write <path>`, exit 2, after `--sync`.** The file is read-only or its folder is not writable. Fix the
  permissions and run it again.

## Related

- [`tools json`](../json/README.md) turns the `--json` output into TOON when that is smaller, so an agent reads
  fewer tokens.
- [`tools secrets`](../secrets/README.md) finds hardcoded keys and tokens in a source tree, the other half of keeping
  secrets out of a repository.
