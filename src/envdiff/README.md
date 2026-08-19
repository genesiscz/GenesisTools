# tools envdiff

> **Diff `.env` against `.env.example`: missing, extra and changed keys, with values masked.**

The check you want after every `git pull` that touched `.env.example`, and the one you want in CI before a deploy discovers the missing key for you.

---

## Quick start

```bash
tools envdiff                                   # .env vs .env.example here
tools envdiff apps/api                          # same, in another directory
tools envdiff .env.production .env.example      # two explicit files
tools envdiff --show-values                     # reveal values instead of masking
tools envdiff --sync                            # append missing keys to .env
tools envdiff --check-values                    # also fail on changed values
tools envdiff --json | tools json               # machine-readable
```

## Arguments and options

| Item | Description |
|------|-------------|
| `[args...]` | Either `[dir]` or `<actualFile> <exampleFile>` |
| `--actual <path>` | Path to the actual env file (default: `<dir>/.env`) |
| `--example <path>` | Path to the reference file (default: `<dir>/.env.example`) |
| `--show-values` | Reveal values instead of masking them |
| `--sync` | Append missing keys to the actual file. Existing keys are untouched. |
| `--check-values` | Also exit 1 on changed values, not only on missing or extra keys |
| `--json` | Emit the diff as JSON |
| `-v, --verbose` | Enable verbose logging |
| `--readme` | Print this file and exit |

---

## Exit codes

`0` when the two files agree on their key sets. `1` when a key is missing or extra. With `--check-values`, a changed value also produces `1`. That makes the bare command a usable CI gate:

```bash
tools envdiff || echo "env drift, see above"
```

## Notes

- Values are masked by default, so the output is safe to paste into an issue or a CI log. `--show-values` is opt-in for a reason.
- ❗ `--sync` writes to your actual env file. It only appends keys that are missing, and never edits or reorders a key you already set, so an existing secret cannot be clobbered. It appends the example's placeholder value, which you then have to fill in.
- "Extra" keys are not errors in every project. A local `.env` often carries machine-specific settings the example does not list. Read the report before treating a non-zero exit as a defect.
