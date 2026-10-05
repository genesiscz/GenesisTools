# tools secrets

> **Find hardcoded API keys, tokens and private keys, and redact secrets from text before an AI sees it.**

Two commands. `scan` is a scanner you can run before a commit or in CI. It exits non-zero on findings, so it works as a gate rather than as a report nobody reads. `redact` swaps secrets and personal data in text for placeholders, and restores them in the reply.

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
| `redact` | Reversibly redact secrets and PII in text. See [Redact](#redact). |
| `redact restore` | Swap the placeholders back to the original values. See [Redact](#redact). |
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
- Related: `tools ai config secret` manages the encrypted vault this toolkit stores its own credentials in, and `tools har-analyzer redact` does the equivalent job for HAR capture files.
- `scan` and `redact` keep separate detector lists on purpose. `scan` matches the shape of a secret and reports the line. `redact` must return the exact span to replace (a whole private key block, only the value after `Bearer`), so the two lists differ in what they match and the tests of each pin that behavior.

---

# Redact

> **Reversibly redact secrets and PII from text before pasting it into an AI, then restore the reply.**

The round trip matters. Masking alone would leave you with an answer full of placeholders. This keeps a mapping, so the model's reply can be turned back into your real paths, keys and addresses.

## The round trip

```bash
# 1. Redact what is on your clipboard, and put the safe version back on it
tools secrets redact --clipboard --out -

# 2. Paste into the AI, get an answer, copy it

# 3. Restore the real values in the answer
tools secrets redact restore --clipboard --out -
```

## Redact quick start

```bash
tools secrets redact --in error.log --out safe.log
cat error.log | tools secrets redact --in -
tools secrets redact --in log.txt --types keys,tokens,emails
tools secrets redact --in log.txt --phones
tools secrets redact --in log.txt --map ./run1.map.json
tools secrets redact --in log.txt --json | tools json

tools secrets redact restore --in answer.md --out answer.real.md
tools secrets redact restore --in answer.md --map ./run1.map.json
```

## Redact options

| Flag | Description |
|------|-------------|
| `-i, --in <file>` | Read input from a file (`-` for stdin) |
| `-c, --clipboard` | Read input from the clipboard |
| `-o, --out <file>` | Write output to a file (`-` for stdout) |
| `-m, --map <file>` | Write the mapping to this file, in addition to the default session |
| `-t, --types <list>` | Detectors to run: `keys`, `tokens`, `emails`, `ips`, `paths` |
| `--phones` | Also redact phone numbers |
| `--json` | Emit `{ redacted, mapping }` as JSON |

### `redact restore` options

| Flag | Description |
|------|-------------|
| `-i, --in <file>` | Read input from a file (`-` for stdin) |
| `-c, --clipboard` | Read input from the clipboard |
| `-o, --out <file>` | Write output to a file (`-` for stdout) |
| `-m, --map <file>` | Mapping file to restore from (default: the latest session) |
| `--json` | Emit `{ restored }` as JSON |

## How the mapping works

Each detected value is replaced by a stable placeholder and both halves are stored in a session mapping. `restore` reverses it. The same real value always maps to the same placeholder inside one run, so the text stays coherent and the model can reason about "the same host" appearing twice.

`restore` defaults to the latest session, which is what you want for a single conversation. Pass `--map` on both sides when you run several redactions in parallel and need them not to collide. Sessions are kept in `~/.genesis-tools/redact/`, the same folder the command used when it was a tool of its own, so mappings saved before the move still restore.

## 🛑 Read this before trusting it

- **The mapping file is as sensitive as the original text.** It contains the real values in plaintext, keyed by placeholder. Anywhere you would not leave the raw secret, do not leave the mapping either.
- **Detection is heuristic.** `--types` covers common shapes of keys, tokens, emails, IPs and filesystem paths. A credential in a format nobody anticipated will pass straight through. Read the redacted output before you paste it.
- **Redaction is not authorization.** If the text should not leave the machine at all, do not send a masked version of it either.
