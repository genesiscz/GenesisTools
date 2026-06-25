# ai-proxy

OpenAI-compatible local proxy for Grok subscription, GitHub Copilot subscription, and future providers. Cursor connects once; model ids use the `account/provider/model` prefix.

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

## Internal

```bash
tools ai-proxy internal update-models --account genesiscz
tools ai-proxy internal update-models --provider github-copilot
```

Writes `src/ai-proxy/data/models-catalog.json` (manual git commit).