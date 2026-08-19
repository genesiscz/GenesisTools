# tools ai

> **Unified AI toolkit: translate, summarize, classify, generate images, and manage accounts and models.**

The user-facing face of the AI subsystem under `src/utils/ai/`. The verbs here are deliberately small. The substantial part is `ai config`, which owns every account, credential and default that the rest of the toolkit resolves against.

---

## Commands

| Command | Description |
|---------|-------------|
| `translate [text]` | Translate text between languages |
| `summarize [file]` | Summarize text from a file, stdin, or the clipboard |
| `image <prompt>` | Generate an image from a text prompt (requires `HUGGINGFACE_TOKEN`) |
| `classify [text]` | Classify text into categories using semantic similarity |
| `models` | Manage downloaded local models |
| `config` | Manage AI accounts, defaults, links, secrets and diagnostics |

## Quick start

```bash
tools ai translate "dobrý den" --to en
tools ai translate "good morning" --to cs --clipboard
echo "long text" | tools ai summarize -
tools ai summarize notes.md --max-length 200
tools ai summarize                                  # summarizes the clipboard
tools ai classify "the build fails on CI" --categories bug,feature,question
tools ai image "a red bicycle in the rain" -o bike.png
```

### Verb options

`translate`: `--to <lang>` (required), `--from <lang>` (auto-detect when omitted), `--provider <provider>` (`local-hf`, `cloud`, `darwinkit`), `-c, --clipboard`.

`summarize`: `--max-length <n>`, `--provider <provider>`, `-c, --clipboard`. The file argument accepts `-` for stdin, and omitting it reads the clipboard.

`classify`: `--categories <list>` (comma-separated), `--provider <provider>`.

`image`: `-o, --output <path>`, `--model <model>` (default `stabilityai/stable-diffusion-xl-base-1.0`).

---

## Local models

```bash
tools ai models list                    # downloaded models with sizes
tools ai models download <model-id>     # fetch one for local use
tools ai models clean                   # remove cached models
```

Local providers avoid a network round trip and an API bill, at the cost of disk and a first-run download. `models clean` is the disk-recovery path.

---

## `ai config`: accounts, defaults, secrets

```bash
tools ai config account add                     # add an account, secrets go into the vault
tools ai config account list
tools ai config account show <id-or-name>       # secret values are never resolved
tools ai config account edit <id-or-name>
tools ai config account test <id-or-name>       # resolve the credential and bind the provider
tools ai config account rm <id-or-name>

tools ai config default set <task> <model-ref>  # point a task at a model or account
tools ai config default list

tools ai config link                            # what references an account

tools ai config secret set <path> [value]       # value comes from stdin or a file
tools ai config secret ls [prefix]              # paths only, never values
tools ai config secret rotate                   # new master key, re-encrypt everything
tools ai config secret export                   # passphrase-protected copy
tools ai config secret import <file>

tools ai config doctor                          # master key, vault, credentials, links, expiries
```

### How credentials are stored

Nothing sensitive is in the config file. Accounts hold **references** into an AES-256-GCM vault at `~/.genesis-tools/security/vault.json`, with a per-entry key derived by HKDF. The master key is resolved from a ladder: the `GENESIS_TOOLS_MASTER_KEY` environment variable, then the OS keychain, then an opt-in key file.

Config itself lives at `~/.genesis-tools/ai/config.json`. It is re-read when its mtime changes, so a long-running proxy notices a login performed in another terminal.

### Model references

The resolution ladder accepts several forms, most specific first:

```
grok-4-fast                  # bare model id
xai/grok-4-fast              # provider-qualified
@account/<id>:<model>        # a specific account
@proxy/<slug>/<model>        # via tools ai-proxy
```

When nothing is specified, the ladder falls back to the app default, then the task default, then the global default.

---

## 🛑 Diagnostics do not mutate

`doctor` and `account test` are read-only by contract. They resolve and report, and they refuse to spend a single-use credential.

This is not a stylistic preference. Both commands once rotated Anthropic OAuth refresh tokens simply by reaching a shared auth path that refreshed on expiry, which meant **diagnosing an account could break it**. The guard now lives in the shared function, immediately before the call that spends the token, rather than at each call site.

## Notes

- `tools ai-proxy link` registers a local proxy as a real account, which is what makes `@proxy/...` references resolve here.
- Cost accounting for calls made through this subsystem is recorded automatically. See `tools usage` for `ask` analytics and [`tools ai-spend`](../ai-spend/README.md) for Claude Code session spend.
- `image` needs `HUGGINGFACE_TOKEN` in the environment. It is the one verb here that is not covered by the account system.
