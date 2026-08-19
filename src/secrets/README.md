# tools secrets

> **Find hardcoded API keys, tokens and private keys.**

A scanner you can run before a commit or in CI. It exits non-zero on findings, so it works as a gate rather than as a report nobody reads.

---

## Quick start

```bash
tools secrets scan                          # current directory
tools secrets scan src/                     # one subtree
tools secrets scan --json | tools json      # machine-readable
tools secrets scan --ignore 'EXAMPLE_KEY'   # allowlist a false positive
tools secrets scan --no-entropy             # patterns only, no entropy detector
tools secrets scan --max-size 256           # skip files over 256 KB
```

## Commands and options

| Item | Description |
|------|-------------|
| `scan [dir]` | Scan a directory (default: current). Exits non-zero on findings. |
| `--json` | Emit JSON to stdout instead of the human report |
| `--no-gitignore` | Do not respect `.gitignore` |
| `--ignore <regex>` | Allowlist: drop findings matching this regex. Repeatable. |
| `--max-size <kb>` | Skip files larger than this many KB (default: 1024) |
| `--no-entropy` | Disable the high-entropy base64 detector |

---

## Two detectors, two failure modes

**Pattern detectors** match known shapes: provider key prefixes, PEM headers, bearer tokens. They are precise and rarely wrong, but they only catch formats they know.

**The entropy detector** flags high-entropy base64-looking strings. It catches keys with no recognizable prefix, and it is the source of nearly every false positive: minified bundles, lockfile hashes, test fixtures and inline images all look random. Use `--ignore` for a specific string and `--no-entropy` when a tree is mostly generated output.

## Using it as a gate

```bash
tools secrets scan && echo "clean"
```

Non-zero means findings, which is what you want in a pre-commit hook or a CI step. Pair it with `--ignore` entries checked into your own wrapper script, so the allowlist is reviewed like code rather than remembered by one person.

## Notes

- ⚠️ A clean scan is not proof there are no secrets. It proves no detector fired. A key stored in a format nobody anticipated, or split across lines, will pass.
- `.gitignore` is respected by default, which is usually right and occasionally hides the very file you care about. A `.env` excluded from git is still on disk. Pass `--no-gitignore` when you want to know what is on the machine rather than what is committed.
- Related: [`tools redact`](../redact/README.md) masks secrets in text you are about to paste into an AI, and `tools ai config secret` manages the encrypted vault this toolkit stores its own credentials in.
