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
| `accounts` | Browser logins, logout, and vendor-home discovery for the subscription providers |
| `usage` | Quota and rate-limit windows for every provider that reports them, plus the polling daemon |

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

`summarize`: `--max-length <n>`, `-c, --clipboard`. The file argument accepts `-` for stdin, and omitting it reads the clipboard.

`classify`: `--categories <list>` (comma-separated).

⚠️ **`summarize` and `classify` register `--provider`, but currently ignore it.** `summarize` calls `AI.summarize(input, { maxLength })` and `classify` calls `classifyText(input, categories)`, neither of which receives the flag (`src/ai/index.ts:163` and `:276`). Passing it silently gets you the default implementation, so do not rely on it to steer either verb. It is documented here rather than omitted so nobody assumes the flag works. `translate` does honour `--provider`.

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

## `ai accounts`: browser logins, logout, home discovery

`ai config account` enters a credential you already hold. `ai accounts` OBTAINS one: the browser OAuth flows, the long-lived token mint, the external `grok login`, and the discovery of vendor home directories. It covers only the subscription plugins that declare account features (`anthropic-sub`, `openai-sub`, `grok-sub`), addressed by alias or plugin id.

```bash
tools ai accounts list [--provider claude|codex|grok] [--json]   # which credentials each account holds, never their values
tools ai accounts show <account> [--json]                        # identity, credential kinds, bound homes; never polls
tools ai accounts login [name] --provider <p> [--home <dir>] [--auth-file <f>]
tools ai accounts login-long [name] --provider claude [--setup-token]
tools ai accounts login-secondary [name] --provider claude
tools ai accounts logout [name] [--provider <p>] [--oauth|--long-lived|--secondary|--auth-file|--all] [-y]
tools ai accounts discover [--provider <p>] [--bind] [--json]    # vendor homes on disk; --bind is the only writing path
tools ai accounts who [--json] [--all]                            # live Claude Code processes and the account each one bills
```

`--provider` is an enumerated flag: in a TTY it prompts, in a pipe (or with an unknown value) it prints the possible values and exits 1.

One core, several doors. `tools claude login|login-long|login-secondary|logout|who`, `tools codex login`, `tools grok login` and `tools ai-proxy accounts login codex` call the same functions in `src/ai/lib/accounts/` with the provider pinned, so a behaviour cannot exist behind one door and not the others.

Where a login lands:

- **claude**: access and refresh token in the vault; the first login also becomes the default account for the `claude` and `ask` apps when they have none.
- **codex**: the codex home's `auth.json` (`~/.codex` or `--home`), in the shape the official CLI reads, and the account stores that path. An account may instead hold a vault-stored token pair, the way `tools ai-proxy accounts login codex` used to write it; both keep working.
- **grok**: no in-process flow. The command prints `grok login` with `GROK_HOME` set, offers to run it, then binds the `auth.json` it wrote.

A re-login merges onto the account of the same name and keeps its long-lived token, secondary grant, label and apps. When the browser proves a different identity than the account already stores, the write needs a confirmation in a TTY and is refused in a pipe.

## `ai usage`: quota across every provider

One dashboard over every plugin that declares `accounts.usage`. The TUI is the default; `--json` and `--no-tui` never import Ink, which is what keeps a scripted read cheap.

```bash
tools ai usage [--provider claude|codex|grok] [--account <name>] [--range 60m|6h|24h|7d] [--json|--no-tui] [--fresh]
tools ai usage daemon register|unregister|status
```

`--provider` and `--range` are enumerated: passed with no value, or with a value that is not on the list, they print the possible ones and exit 1.

`tools claude usage`, `tools codex usage` and `tools grok usage` are the same dashboard pinned to one provider. `tools claude usage` additionally keeps its Sessions tab, the `--token`, `--watch` and `--scored` flags, and its `usage sessions` subcommand.

`daemon register` owns the single `ai-usage-poll` task and removes the old claude-only `claude-usage-poll` on the way through. Running it once is the whole migration. `tools claude daemon` is an alias for the same three subcommands.

## 🛑 Diagnostics do not mutate

`doctor`, `account test`, `accounts list`, `accounts show`, `accounts discover` (without `--bind`) and `accounts who` are read-only by contract. They resolve and report, and they refuse to spend a single-use credential.

This is not a stylistic preference. Both commands once rotated Anthropic OAuth refresh tokens simply by reaching a shared auth path that refreshed on expiry, which meant **diagnosing an account could break it**. The guard now lives in the shared function, immediately before the call that spends the token, rather than at each call site.

## Notes

- `tools ai-proxy link` registers a local proxy as a real account, which is what makes `@proxy/...` references resolve here.
- Cost accounting for calls made through this subsystem is recorded automatically. See `tools usage` for `ask` analytics and [`tools ai-spend`](../ai-spend/README.md) for Claude Code session spend.
- `image` needs `HUGGINGFACE_TOKEN` in the environment. It is the one verb here that is not covered by the account system.
