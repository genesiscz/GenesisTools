# ai-proxy

OpenAI-compatible local proxy for Grok subscription, GitHub Copilot subscription, Anthropic (Claude Max/Pro) subscription, OpenAI (ChatGPT/Codex) subscription, and future providers. Cursor connects once; model ids use the `account/provider/model` prefix.

## Quick start

```bash
tools ai-proxy config          # interactive menu
tools ai-proxy config init
tools ai-proxy accounts login github-copilot
tools ai-proxy config setup-tunnel   # cloudflared / tailscale / custom
tools ai-proxy up              # start proxy (+ tunnel if configured)
tools ai-proxy status
tools ai-proxy introspect --clipboard
```

Config lives at `~/.genesis-tools/ai-proxy/config.json` (via `AiProxyStorage`).

## Cursor BYOK

```text
Override OpenAI Base URL: https://<hostname>/ai/v1   # or local http://127.0.0.1:8317/v1
API Key: <proxyApiKey from config>
Model: genesiscz/grok/grok-composer-2.5-fast
Model: genesiscz/github-copilot/claude-sonnet-4
```

`ai-proxy down` stops **only** the proxy process — never the shared cloudflared tunnel
(dev-dashboard and other routes on the same hostname keep running).

Start with `ai-proxy serve --translate-cursor auto`. If Agent mode breaks, try `--no-translate` or `--translate-cursor on`.

## Model ids

Canonical format:

```text
<account>/<provider>/<upstreamModelId>
```

Examples:
- `genesiscz/grok/grok-composer-2.5-fast`
- `genesiscz/github-copilot/claude-sonnet-4`
- `genesiscz/claude-sub/sonnet` (aliases: `sonnet`, `opus`, `haiku`, `fable` — resolve to the current dated Claude model ids)
- `genesiscz/codex/gpt-5.5`

## Auth

### Grok subscription

Read from `~/.grok/auth.json`. The proxy does **not** refresh OAuth tokens — run `grok` or `grok login` when auth expires.

### GitHub Copilot subscription

```bash
tools ai-proxy accounts login github-copilot
```

Device OAuth stores `github_token` under `~/.local/share/copilot-api/` (override via `githubCopilot.dataDir` in config). Copilot session tokens are cached in `session.json` and refreshed automatically.

Account config shape:

```json
{
  "name": "genesiscz",
  "provider": "github-copilot-subscription",
  "providerSlug": "github-copilot",
  "enabled": true,
  "githubCopilot": {
    "dataDir": "~/.local/share/copilot-api",
    "type": "individual"
  }
}
```

### Anthropic (Claude Max/Pro) subscription

Speaks OpenAI (`/v1/chat/completions`) to proxy clients and forwards the Claude Code spoof (Bearer OAuth token + billing header + beta flags) to `api.anthropic.com/v1/messages`. There is no interactive `accounts login` flow for this provider yet — add the account to `~/.genesis-tools/ai-proxy/config.json` by hand, pointing `anthropicSub.accountName` at an account already configured for `tools claude` / `tools ask` (run `tools claude login` first if you don't have one):

```json
{
  "name": "genesiscz",
  "provider": "anthropic-subscription",
  "providerSlug": "claude-sub",
  "enabled": true,
  "anthropicSub": {
    "accountName": "foltyn"
  }
}
```

`accountName` is the name of the account in `~/.genesis-tools/ai/config.json` (the shared AI config used by `tools claude`/`tools ask`) whose OAuth token gets billed — it does not have to match the proxy account's own `name`. The Responses API (`/v1/responses`) is not supported by this provider; use `/v1/chat/completions`.

### OpenAI (ChatGPT/Codex) subscription

Speaks OpenAI to proxy clients on both `/v1/chat/completions` and `/v1/responses`, converting to/from the ChatGPT backend's Responses-only WHAM API (`chatgpt.com/backend-api/wham/responses`, streaming-only — non-streaming callers get the SSE accumulated into a single JSON response). No interactive `accounts login` flow yet — add the account by hand:

```json
{
  "name": "genesiscz",
  "provider": "openai-subscription",
  "providerSlug": "codex",
  "enabled": true,
  "openaiSub": {
    "accountName": "codex-account"
  }
}
```

Two token sources, tried in order:
- `openaiSub.accountName` set → the named `openai-sub` account in `~/.genesis-tools/ai/config.json` (refreshed via Codex OAuth and persisted).
- `openaiSub.accountName` omitted → the Codex CLI's own cache (`~/.codex/auth.json`, read-only; run `codex login` to refresh it). Override the path with `openaiSub.codexAuthPath`.

## Usage analytics

- **Subscription:** `tools ai-proxy usage --account genesiscz`
- **API key (Management API):** configure `managementKeyEnv` + `teamId` on xai-api-key accounts
- **Local request history:** `tools ai-proxy usage --recent 5`
- **Store paths:** `tools ai-proxy usage --paths`

### Local usage store

The proxy appends one JSON object per completed request under `~/.genesis-tools/ai-proxy/usage/`:

- `requests.jsonl` — per-request log (model, latency, status, token counts)
- `daily.json` — today's rollup by account/model
- `billing.json` — cached subscription billing snapshots (5 min TTL)

Data stays on disk locally only. To reset history, truncate or delete `requests.jsonl` (and optionally `daily.json`).

### Client billing (2026-07)

Multi-user (VPS) mode: give each downstream user its own key via `clients` in `~/.genesis-tools/ai-proxy/config.json`, while `proxyApiKey` stays the owner key. Example:

```json
"clients": [
  { "name": "eve-service", "key": "<32+ char secret>", "monthlyTokenCap": 5000000, "monthlyCostCapUsd": 25 }
]
```

- **No-resale invariant:** client keys can NEVER route to subscription providers (grok / copilot / anthropic / openai subscription) — only `proxyApiKey` (owner) can. Client attempts get `403 {"type":"forbidden","code":"provider_not_allowed"}`; a config that grants a subscription provider to a client refuses to boot.
- **Quotas:** `monthlyTokenCap` / `monthlyCostCapUsd` are enforced per UTC month against `usage/clients.json`; over-cap requests get `429 {"type":"quota_exceeded","code":"monthly_quota_exceeded"}`.
- **Manage:** `tools ai-proxy clients add <name> [--token-cap N] [--cost-cap USD] [--provider <type>...]` prints the generated key ONCE; `tools ai-proxy clients list` (keys masked); `tools ai-proxy clients usage [--month YYYY-MM] [--csv]` (CSV = the v1 invoicing export).
- **eve-service:** eve connects as ONE client key (`eve-service`) with its own caps — set that key as eve's OpenAI-compatible API key against the proxy; splitting eve traffic per end-user is a later plan.

## Internal

```bash
tools ai-proxy internal update-models --account genesiscz
tools ai-proxy internal update-models --provider github-copilot
```

Writes `src/ai-proxy/data/models-catalog.json` (manual git commit).