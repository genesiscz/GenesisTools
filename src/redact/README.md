# tools redact

> **Reversibly redact secrets and PII from text before pasting it into an AI, then restore the reply.**

The round trip matters. Masking alone would leave you with an answer full of placeholders. This keeps a mapping, so the model's reply can be turned back into your real paths, keys and addresses.

---

## The round trip

```bash
# 1. Redact what is on your clipboard, and put the safe version back on it
tools redact --clipboard --out -

# 2. Paste into the AI, get an answer, copy it

# 3. Restore the real values in the answer
tools redact restore --clipboard --out -
```

## Quick start

```bash
tools redact --in error.log --out safe.log
cat error.log | tools redact --in -
tools redact --in log.txt --types keys,tokens,emails
tools redact --in log.txt --phones
tools redact --in log.txt --map ./run1.map.json
tools redact --in log.txt --json | tools json

tools redact restore --in answer.md --out answer.real.md
tools redact restore --in answer.md --map ./run1.map.json
```

## Options

| Flag | Description |
|------|-------------|
| `-i, --in <file>` | Read input from a file (`-` for stdin) |
| `-c, --clipboard` | Read input from the clipboard |
| `-o, --out <file>` | Write output to a file (`-` for stdout) |
| `-m, --map <file>` | Write the mapping to this file, in addition to the default session |
| `-t, --types <list>` | Detectors to run: `keys`, `tokens`, `emails`, `ips`, `paths` |
| `--phones` | Also redact phone numbers |
| `--json` | Emit `{ redacted, mapping }` as JSON |
| `--readme` | Print this file and exit |

### `restore` options

| Flag | Description |
|------|-------------|
| `-i, --in <file>` | Read input from a file (`-` for stdin) |
| `-c, --clipboard` | Read input from the clipboard |
| `-o, --out <file>` | Write output to a file (`-` for stdout) |
| `-m, --map <file>` | Mapping file to restore from (default: the latest session) |
| `--json` | Emit `{ restored }` as JSON |

---

## How the mapping works

Each detected value is replaced by a stable placeholder and both halves are stored in a session mapping. `restore` reverses it. The same real value always maps to the same placeholder inside one run, so the text stays coherent and the model can reason about "the same host" appearing twice.

`restore` defaults to the latest session, which is what you want for a single conversation. Pass `--map` on both sides when you run several redactions in parallel and need them not to collide.

## 🛑 Read this before trusting it

- **The mapping file is as sensitive as the original text.** It contains the real values in plaintext, keyed by placeholder. Anywhere you would not leave the raw secret, do not leave the mapping either.
- **Detection is heuristic.** `--types` covers common shapes of keys, tokens, emails, IPs and filesystem paths. A credential in a format nobody anticipated will pass straight through. Read the redacted output before you paste it.
- **Redaction is not authorization.** If the text should not leave the machine at all, do not send a masked version of it either.

## Related

- [`tools secrets`](../secrets/README.md) scans a repository for hardcoded credentials.
- `tools har-analyzer redact` does the equivalent job for HAR capture files.
