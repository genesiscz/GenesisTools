---
paths:
  - "src/utils/ai/**"
  - "src/utils/security/**"
  - "src/utils/agent-sessions/**"
  - "src/ai-proxy/**"
  - "src/ask/**"
  - "src/claude/**"
  - "src/codex/**"
---

# AI subsystem, accounts, secrets, agent history

Loaded by Claude Code when you read, write or edit a file in the AI, security, agent-history, ask, ai-proxy, claude or codex folders.

## AI subsystem (layers, accounts, secrets) — one place, do not add new rate tables

Everything AI lives under `src/utils/ai/` + `src/utils/security/`, in layers that import only DOWNWARD. Adding a provider means adding one plugin folder, not touching six call sites.

- **L0 `src/utils/security/`**: `SecretStore` is an AES-256-GCM vault at `~/.genesis-tools/security/vault.json`, per-entry key via HKDF, written under `Storage.withFileLock`. Credentials in config are `SecureRef`s (`{ type: "secure", path: "ai/<accountId>/<field>" }`), never plaintext. The master key comes off a ladder: `GENESIS_TOOLS_MASTER_KEY` env, then the OS keychain, then an opt-in key file (`keyring/headless.ts`). The keychain rung goes through `@napi-rs/keyring` on every platform and NEVER the `security` CLI: macOS grants silent access by code signature, so the same `bun` that wrote an item reads it back with no prompt, while a second binary gets prompted.
  - 🛑 **Tests can never reach the real keychain.** Five independent layers stop them (sandboxed service name, under-test rung block, a `@napi-rs/keyring` preload mock, a non-interactive write barrier, dual-signal test detection), pinned by `keyring/keychain-guard.test.ts`.
- **L1 `src/utils/ai/config/`**: `AiConfigStore` is the single reader/writer of the v4 `~/.genesis-tools/ai/config.json` (accounts with immutable `id` plus renameable `name`, `defaults.{account,task,app}`, aliases). It re-reads on mtime change, so a long-running proxy sees a `tools claude login` from another terminal. Mutate through `mutate()` / `withLock()`, never by writing the file directly. `AIConfig` survives only as a deprecated facade.
- **L2 `src/utils/ai/providers/`**: one folder per provider implementing `ProviderPlugin` (`kind`, `capabilities`, `credential`, `bind()`, optional `health()`). `resolveCredential` is the ONE chokepoint deciding where a key comes from: the account first, a DECLARED env var second. Ambient env pickup that no account claims is an error naming the fix command, except the grandfathered set, which keeps working through `ephemeralEnvAccounts` (in memory, names the variable, never copies the value).
- **L3 `src/utils/ai/catalog/`**: `STATIC_CATALOG` plus `byId(id, provider?)` and `pricingFor()` (static, then LiteLLM, then OpenRouter). Pricing supports dated and context-banded `rules`, resolved by the pure `effectivePricing()`.
- **L4 `src/utils/ai/core/`**: `resolveModel` / `resolveModelTarget` is the ONE resolution ladder (explicit ref, then app default, then task default, then global), and `coreChat` / `callLLM` the one transport. `ModelRef` grammar: `"grok-4-fast"`, `"xai/grok-4-fast"`, `"@account/<id>:<model>"`, `"@proxy/<slug>/<model>"`.
- **L5 `src/utils/ai/tasks/`**: the `ai.*` facade (`chat`, `embed`, `transcribe`, `speak`, `synthesize`, `summarize`, `translate`, `image`; `realtime` throws a documented `NotImplementedError`). It owns binding lifetime, so a facade verb disposes the binding it resolved. That matters because local runtimes hold native handles.
- **L6 `src/utils/ai/session/`** and **L7 `src/utils/ai/usage/`**: shared session store plus mini-agent, and `recordUsage` / `queryUsage`. `recordUsage` NEVER throws (it sits in the hot path of every call) and records `costSource` so a derived price is never mistaken for a booked one.

**Codex account ownership:** `src/utils/ai/openai/account-binding.ts` is the shared subscription binding for native terminals, workers, usage and SDK requests. Keep immutable account/workspace identity across refresh and renames. Vault grants have one refresh owner; native auth-file references are read-only. Diagnostics use `AiConfigStore.readOnly()` for metadata too, because ordinary `load()` may run migrations. Native app-server authentication uses external tokens with ephemeral credential storage; never swap the shared home's auth file.

**Native CLI history:** extend `ProviderPlugin.codingAgent` and the readers/index under `src/utils/agent-sessions/`; do not add another provider registry. This derived history index is separate from app-owned `src/utils/ai/session/` conversations. Session identity includes provider, native ID and canonical source home. Import through the provider's native API with source-preserving provenance; never manufacture native SQLite rows or infer historical account ownership from today's login.

**Cost math is `src/utils/ai/llm-cost.ts` only**: `calculateCallCostUsd` (prices cache reads and writes at their own rates) and `estimateLlmCallCostUsd`. No rate table belongs there, or anywhere new.

⚠️ **ai@7's Anthropic provider folds cache tokens into top-level `inputTokens`.** Recording that field as billable input charges cached tokens twice, once at the full rate and again at the cache rate. Use `usageInputNoCacheTokens(usage)` from `@genesiscz/utils/ask/usage-tokens`.

🛑 **Deliberate exception, do not "deduplicate":** `src/ai-proxy/lib/billing/pricing.ts` keeps a STATIC rate table. It is the ai-proxy client-ledger invoicing source of truth: deterministic, offline, and its rates may intentionally differ from list prices. Cost is booked at WRITE time (`recordClientUsage()`), so a later rate edit never rewrites past invoices. Readers print the stored `cost_usd` and never recompute. `pricing.test.ts` asserts every priced prefix still names a known model, never rate equality.

**Guards.** `scripts/ci/ai-credentials-guard.sh` fails the build on argless `createOpenAI(` / `createGroq(`, bare `@ai-sdk` singletons outside `providers/`, and any `new Storage("ai")` outside `src/utils/ai/config/**` (need a path? use `aiDataDir()` from `config/paths.ts`). All three rules skip prose that merely names the pattern, by post-filtering matched output lines whose content begins with `//`, `*` or `#`. A line like `/* keep */ const s = new Storage("ai")` is still caught: only the line's leading marker is checked, never the whole line.

**CLI.** `tools ai config account add|list|show|edit|rm|test`, `default set`, `link ls`, `secret set|rotate|export|import`, and `tools ai config doctor` (per-account credential diagnosis). `tools ai-proxy link` registers the proxy as a real account so `@proxy/...` refs resolve.

🛑 **A diagnostic must never mutate.** See "Side Effects: Diagnostics & Irreversible Operations" in `.claude/rules/code.md`. `doctor` and `account test` pass `probe: true`, and each plugin's shared auth path refuses to spend a single-use refresh token.

## Provider history storage

Claude, Codex and Grok history share `~/.genesis-tools/claude-history/index.db` through `src/utils/agent-sessions/` and `ProviderPlugin.codingAgent`. Reuse the shared service/repositories; keep provider parsing behind readers. Source text stays in native files/projections, with bounded metadata and aggregate contributions in SQLite.

This database also contains historical `usage_snapshots` and `spend_snapshots`. Never remove it as a disposable cache, clear observation tables during history rebuild, or run unscoped history SQL across providers. Cached runtime/title/status lookup must not initialize schemas or discover sources. Ordinary searches refresh metadata automatically; full statistics refresh is separate.
