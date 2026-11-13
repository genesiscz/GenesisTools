# tools ai-proxy

A local OpenAI-compatible and Anthropic-compatible HTTP proxy in front of your AI subscriptions and API keys: Grok,
GitHub Copilot, Claude (Max/Pro), ChatGPT/Codex, xAI, OpenAI and OpenRouter. Cursor, Claude Code, the OpenAI and
Anthropic SDKs, and other GenesisTools all connect to one URL with one key, and pick an upstream through the model id
(`<account>/<provider>/<model>`). The proxy also keeps a local ledger of every request, its tokens, cache hits and cost.

## Quick start

```bash
tools ai-proxy config init                            # write a config from the logins and keys found on this Mac
tools ai-proxy accounts login codex                   # add a ChatGPT/Codex subscription (browser OAuth)
tools ai-proxy install                                # launchd agent: starts at login, respawns on crash
tools ai-proxy status                                 # is it running, which URL, launchd or not
tools ai-proxy introspect --clipboard --show-secrets  # copy the base URL, the full key and model ids for Cursor
tools ai-proxy monitor --errors                       # watch failed requests live
```

Without launchd, `tools ai-proxy up` starts a detached proxy for this login session and `tools ai-proxy down` stops it.
The default address is `http://127.0.0.1:8317/v1`.

## Commands

The tool itself takes `-v, --verbose` and `--readme` (print this page). `tools ai-proxy config` with no subcommand
opens an interactive menu.

### Run the proxy

| Command | What it does |
|---|---|
| `up` | Start the proxy in the background, then the public tunnel when one is configured. |
| `down` | Stop the proxy only. It never stops the shared cloudflared tunnel. |
| `serve` | Run the server in the foreground (what `up` and launchd run). |
| `install [--json]` | Write and load the launchd agent (macOS). |
| `uninstall [--json]` | Unload and delete the launchd agent. The proxy stops. |
| `status [--json]` | Proxy and public exposure status, and whether launchd owns the proxy. |

`serve` flags: `--port <number>`, `--host <host>`, `--translate-cursor auto|on|off`, `--thinking raw|cursor|folded`,
`--no-translate`. Without flags it uses `listen` and `translation` from the config.

### Accounts

| Command | What it does |
|---|---|
| `accounts list` | Every configured account, with its model count and a FAILOVER column. |
| `accounts login <provider>` | OAuth login. `github-copilot` (device flow), or `codex` (also `openai`, `chatgpt`): the ChatGPT subscription in the browser, not an API key. |
| `accounts test <name>` | Ping the upstream for one account. |
| `accounts enable <name>` / `disable <name>` | A disabled account stays in the config and is skipped at runtime. |
| `accounts remove <name>` | Delete the account from the config. |
| `accounts set-key <name> [key]` | Pick an api-key account's credential. Without `key`: a masked interactive chooser. |
| `accounts allow-env <name>` | Let the account spend its environment key. It deletes a key stored on the account, because the environment key replaces it. `--env <NAME>` names another variable, `--off` revokes. |
| `accounts failover <name> [on\|off]` | Show or set Codex failover (off by default). |
| `accounts status` | Codex accounts only: auth source, token expiry, ChatGPT plan. |
| `accounts bind <name> --codex <login>` | Point a Codex account at a managed `openai-sub` login. |
| `accounts set-routing <name>` | OpenRouter only: pin provider routing. Flags in [OpenRouter](#openrouter-api-key). |

`set-key` with the key as an argument works for scripts, but the key lands in shell history and in `ps`. It is stored
in plain text in `config.json` (file mode 0600), and it clears `allowEnvApiKey`. The chooser offers four states: use
the environment variable, store a key, remove the stored key, or use no key. `status`, `bind` and `set-routing` exist
only because a provider registers them (`lib/providers/account-commands.ts`).

### Config

| Command | What it does |
|---|---|
| `config` | Interactive menu: setup-tunnel, up, init, detect, show. |
| `config detect` | Report the Grok login, Copilot login and API keys found on this Mac. Writes nothing. |
| `config init [--append]` | Create the config from what `detect` finds. `--append` adds only missing providers. |
| `config show` | Print the config with secrets redacted. |
| `config set` | Change single values (flags below). |
| `config setup-tunnel` | Interactive setup of public exposure: a cloudflared tunnel, a Tailscale hostname or a custom URL. It offers to install cloudflared with Homebrew. |

`config set` flags:

```text
--port <number>                  listen port
--proxy-key <key>                the owner key clients present
--translate <mode>               Cursor translation: auto|on|off
--thinking <mode>                raw|cursor|folded
--public-hostname <host>         e.g. proxy.example.dev
--public-base-path <path>        URL prefix on that host, e.g. /ai
--exposure-mode <mode>           none|cloudflared|tailscale|custom
--public-base-url <url>          full base URL (.../v1) for mode=custom
--tunnel-name <name>             cloudflared tunnel name
--cloudflared-config <path>      cloudflared config.yml
--cloudflared-auto-start <bool>  start the tunnel on up (true|false)
```

### Models and inventory

- `models`: proxy model ids and metadata. `--provider <slug>`, `--visibility high|medium|low`, `--cursor-ids` (ids
  only), `--json`.
- `introspect` (alias `ls`): a copy-paste inventory for Cursor BYOK. `--section accounts|endpoints|models|cursor|all`,
  `--account <name>`, `--clipboard`, `--show-secrets`, `--json`.
- `link [--status]`: register the proxy as an account in the shared AI config, so `@proxy/<slug>/<model>` refs resolve
  in other tools. `--status` only reports.
- `internal update-models`: probe upstream models and write `models-catalog.json`. `--account <name>`,
  `--provider grok|github-copilot`, `--dry-run`, `--no-probe` (picker catalog only).

`introspect` masks the proxy key unless you pass `--show-secrets`. Its `--json` form includes the account entries as
stored, so a key saved with `set-key` appears in it.

### Sessions, calls and usage

- `sessions`: one row per session record: accounts, model, requests, tokens, cache hit %, losses, last error.
  `--open`, `--since <when>` (default `7d`), `--json`.
- `session <id>`: one session: its record, then one row per request with cache read, write, hit % and losses.
  `-f, --follow`, `--json`.
- `session <id> use`: switch the session's accounts with no restart. `--codex <account>`, `--claude <account>`,
  `--grok <account>`, `--allow-metered <account>` (repeatable).
- `session <id> compaction-restore --marker <gtc1-id> --from <record-file>`: put back a saved native compaction.
- `session <id> compaction-drop --marker <gtc1-id> --acknowledge-context-loss`: continue without a lost compaction.
- `stats`: cache totals per agent: hit %, its spread per request and per session, losses by cause. `--session <id>`,
  `--agent codex|claude|grok|other` (`anthropic` means `claude`), `--since <when>` (default `7d`),
  `--from-transcripts`, `--json`.
- `monitor`: live requests and compaction events, one line each. Flags below.
- `calls`: query proxied calls and open their full transcripts. Flags below.
- `usage`: subscription or Management API usage, plus local history. `--account <name>`, `--provider <type or slug>`,
  `--recent <n>`, `--breakdown` (per model, last 30 days), `--paths`, `--json`.

`--since` on `sessions` and `stats` takes a duration (`1d`, `7d`) or a local date. `stats --from-transcripts` reads
Claude Code's own transcripts instead of the proxy ledger, and takes the agent from the model id.

`monitor` flags: `--session <prefix>` (the proxy record, Claude Code's id, or a request's session tag),
`--model <text>`, `--compaction`, `--slow <secs>` (events always print), `--errors` (failed requests and the warning
events `retry`, `missed`, `background-wasted`, `background-failed`, `blocked` and `cache-reset`; `--help` names only
the first five), `--since <minutes>` (print the recent past first), `--once` (print the backlog and stop), `--json` (one
object per line). It is made for an agent's Monitor tool:

```bash
tools ai-proxy monitor --session 8cf9eff2 --compaction --errors
```

`calls` flags: `--session <id>` (substring of `x-gt-session`), `--stage <name>` (exact `x-gt-stage`),
`--label <text>` (substring of `x-gt-label`), `--model <text>`, `--slower-than <secs>`, `--since <minutes>`,
`--limit <n>` (default 40, newest kept), `--show` (full prompt and response), `--timeline` (dispatch, TTFB, thinking
and text phases), `--json`.

### Clients (multi-user keys)

| Command | What it does |
|---|---|
| `clients list` | Configured clients, keys masked. |
| `clients add <name>` | Add a client; print its key once. `--token-cap <n>`, `--cost-cap <usd>`, `--provider <type...>`. |
| `clients secure` | Move plaintext client keys from `config.json` into the vault. |
| `clients usage` | Per-client monthly usage as JSON. `--month YYYY-MM` (default: the current UTC month), `--csv` for invoicing. |

See [Client keys and billing](#client-keys-and-billing).

## How it works

### Endpoints

| Route | Notes |
|---|---|
| `GET /health`, `GET /v1/health` | No key needed. Answers `{"status":"ok"}`. |
| `GET /v1/models` | The model list. A session key gets its session's picker list. |
| `POST /v1/chat/completions` | OpenAI chat. Every provider. |
| `POST /v1/responses` | OpenAI Responses. Not on `anthropic-subscription` (400) or OpenRouter (501). |
| `POST /v1/messages` | Anthropic Messages, for Claude Code and the Anthropic SDKs. |
| `POST /v1/messages/count_tokens` | An estimate, about 4 characters per token. |
| `POST /v1/audio/transcriptions` | Whisper-compatible speech to text, uploads up to 25 MB. |
| `GET /v1/realtime` | WebSocket speech to speech. See [REALTIME.md](REALTIME.md). |
| `POST /v1/realtime/client_secrets` | Off unless `realtime.allowClientSecrets` is true. |

- Clients authenticate with `Authorization: Bearer <key>` or `x-api-key: <key>`. The key is the owner key
  (`proxyApiKey`), a client key, or a session key (`gts_…`) that `tools claude codex` gives one Claude Code session.
  An unknown or closed session key gets a 403 before any route runs.
- `/openai/v1/...` is an alias of `/v1/...`. A configured `public.basePath` (default `/ai`) is stripped first, so
  `https://proxy.example.dev/ai/v1` reaches the same routes.
- The config is re-read on every request, and routes resolve against that fresh copy. An account's provider is built
  on its first request and rebuilt when the account's config or its referenced credential changes. So account edits
  apply on the next request with no restart: `enable`, `disable`, `remove`, `failover`, `set-key`, `allow-env`,
  `set-routing`, `baseUrl` and the provider blocks. `enable`, `disable`, `set-key` and `allow-env` still print a
  restart hint; you can ignore it.
- A restart (`tools ai-proxy down && tools ai-proxy up`) is needed for `listen.port`, `listen.host`,
  `public.basePath`, the `serve` flags, and a new value of an environment variable. The running proxy keeps the
  environment it started with, and the launchd agent passes it no API keys.

### Model ids

```text
<account>/<provider>/<upstreamModelId>
```

Examples:

- `alice/grok/grok-composer-2.5-fast`
- `alice/github-copilot/claude-sonnet-4`
- `alice/claude-sub/sonnet` (aliases `sonnet`, `opus`, `haiku`, `fable` resolve to the current dated Claude ids)
- `alice/codex/gpt-6.1-sol`
- `work/xai/grok-4.7`
- `router/openrouter/anthropic/claude-sonnet-5.5` (OpenRouter ids have a slash of their own, so four segments)

The provider part is the account's `providerSlug`. The defaults are `grok`, `github-copilot`, `claude-sub`, `codex`,
`xai`, `openai` and `openrouter`.

#### Pinning reasoning effort with `:<effort>`

```text
<account>/<provider>/<upstreamModelId>:<effort>
```

Values: `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`. Example: `alice/grok/grok-4.6:xhigh`.

- **On the OpenAI fields, the client's own value wins.** An explicit `reasoning_effort`, or `reasoning.effort` on the
  Responses route, takes precedence. The suffix is the fallback.
- **On `/v1/messages`, the suffix wins.** It beats Claude Code's `/effort` setting (`output_config.effort`).
- **Only known effort words are split off.** OpenRouter ids use colons too (`:free`, `:batch`), so any other suffix
  stays on the upstream id.
- **Codex models check the effort against the model's own list.** The list comes from the live WHAM `/models` record,
  then the Codex CLI's `~/.codex/models_cache.json`, then the static table (`tools codex models` prints it with the
  source of each field). `max` is sent as `max`. `ultra` is never sent (the backend answers 400): it runs as the
  model's `multi_agent_reasoning_effort`, else `max` (gpt-6.1-sol and gpt-6-astra run it as `xhigh`, gpt-6-sol as
  `max`). An effort the model does not list is a 400 that names the allowed ones. A Codex model the catalog does not
  know keeps the older fixed list, where `max` runs as `xhigh`. xAI and OpenRouter map `ultra` to `xhigh`, like `max`.
- **Not on the Claude subscription's `/v1/messages`.** Only `anthropic-subscription` passes the Anthropic body through
  without the suffix, and a debug line records the drop. Anthropic rejects the field outright
  (`reasoning_effort: Extra inputs are not permitted`). The Grok passthrough (`shim` mode) takes the suffix, because
  Grok's CLI proxy ignores unknown fields. The Grok and Codex Responses routes take it too.

### Providers and accounts

An account is one entry in `accounts[]` of the config. `name` is yours, `provider` is the type, `providerSlug` is the
middle part of the model id. Subscription accounts link to a login in the shared AI config
(`~/.genesis-tools/ai/config.json`, the one `tools claude`, `tools codex` and `tools ask` use). The old name fields
(`grok.accountName`, `anthropicSub.accountName`, `openaiSub.accountName`) still work: on first load the proxy writes
an `account: "@account/<immutable id>"` ref beside them, so renaming the login later does not break the link.

#### Grok subscription (`grok-subscription`)

Reads the Grok CLI login from `~/.grok/auth.json` (`grok.authPath` overrides it), or from a `grok-sub` login in the
shared AI config when `grok.accountName` is set. When the token expires, the proxy runs the OIDC refresh grant itself,
which rotates the refresh token in that file. A diagnosis (`accounts test`, `status`) never refreshes, because the
grant is single use. When the refresh fails (the grant is spent or revoked), run `grok` or `grok login`, then retry.
`config detect` finds the login.

#### GitHub Copilot subscription (`github-copilot-subscription`)

```bash
tools ai-proxy accounts login github-copilot
```

The device flow prints a URL and a code. The GitHub token goes into the macOS Keychain (service
`ai-proxy.github-copilot`; a file under `~/.local/share/auth-storage/` on other systems), and an old plain
`github_token` file is deleted. Copilot session tokens are cached in `session.json` in the data folder
(`~/.local/share/copilot-api/`; `githubCopilot.dataDir` or `COPILOT_API_HOME` moves it) and refresh automatically.

Without that token, the GitHub token comes from `COPILOT_GITHUB_TOKEN`, then `GITHUB_TOKEN`, `GH_TOKEN` or
`GITHUB_PERSONAL_ACCESS_TOKEN`, then the Copilot CLI's own login: a token file under `~/.copilot/`, or its
`copilot-cli` Keychain item, which is read only after an auth failure and with a notice first.

```json
{
  "name": "alice",
  "provider": "github-copilot-subscription",
  "providerSlug": "github-copilot",
  "enabled": true,
  "githubCopilot": { "dataDir": "~/.local/share/copilot-api", "type": "individual" }
}
```

#### Claude subscription (`anthropic-subscription`)

Speaks OpenAI (`/v1/chat/completions`) and Anthropic (`/v1/messages`) to clients, and forwards to
`api.anthropic.com/v1/messages` the way Claude Code does (Bearer OAuth token, billing header, beta flags). There is no
`accounts login` for it: run `tools claude login` first, then add the account by hand, pointing
`anthropicSub.accountName` at that login. The login name does not have to match the proxy account's `name`.

```json
{
  "name": "alice",
  "provider": "anthropic-subscription",
  "providerSlug": "claude-sub",
  "enabled": true,
  "anthropicSub": { "accountName": "personal" }
}
```

`/v1/responses` answers 400 for this provider; use `/v1/chat/completions`.

#### ChatGPT/Codex subscription (`openai-subscription`)

Serves `/v1/chat/completions`, `/v1/responses` and `/v1/messages`, converted to and from the ChatGPT backend's
Responses-only WHAM API (`chatgpt.com/backend-api/wham/responses`). WHAM only streams; a non-streaming caller gets
the stream collected into one JSON response.

```bash
tools ai-proxy accounts login codex      # browser OAuth; saves an openai-sub login and adds or updates the proxy account
tools ai-proxy accounts status           # auth source, token expiry, ChatGPT plan
```

Manual config:

```json
{
  "name": "alice",
  "provider": "openai-subscription",
  "providerSlug": "codex",
  "enabled": true,
  "failover": false,
  "openaiSub": {
    "accountName": "codex-main",
    "failoverAccountNames": ["codex-backup"],
    "defaultReasoningEffort": "low",
    "reasoningSummary": "auto",
    "aliases": { "fast": "gpt-5.4-mini" }
  }
}
```

Token source:

- `openaiSub.accountName` (required for a new account) names an `openai-sub` login in the shared AI config. It goes
  through `CodexAccountBinding`, the one Codex auth engine that `tools codex run` and `tools codex spawn` use too,
  refreshed under one lock.
- Legacy: without `accountName`, the proxy reads the Codex CLI's own cache (`~/.codex/auth.json`, read-only, never
  refreshed by GenesisTools; `openaiSub.codexAuthPath` overrides the path). Configs written before 2026-10-25 keep
  working; the proxy logs a warning once per process, and `accounts status` names the fix:
  `tools ai-proxy accounts bind <account> --codex <login>`.

Behavior:

- **Errors instead of failover (the default, decided 2026-10-25).** The proxy never moves to another account by
  itself. A 401 gets one forced token refresh and one retry on the same login. After that, every account failure
  reaches the client as a readable error: the agent, account, model, upstream status and code, the reset time in
  local time when the upstream gives one, and what to do. A session key's error names its switch command
  (`tools ai-proxy session <id> use --codex <account>`); another client's error names
  `tools ai-proxy accounts failover <account> on`.
- **Status codes on `/v1/messages` are chosen for Claude Code.** Measured on Claude Code 2.1.296: it retries 401,
  429, 5xx and 529 ten times over about 190 s, and stops at once on 400. So a usage limit, a plan that cannot serve
  the model, and a dead login go out as 400. A short rate limit stays 429 with its `Retry-After`. An overload
  (`server_is_overloaded` or `slow_down`, also when the stream fails before its first output) goes out as 529, so
  Claude Code retries it. The OpenAI routes keep the upstream status, with the same text in the OpenAI error envelope.
- **Failover (opt in per account):** `tools ai-proxy accounts failover <account> on`, or `"failover": true`. Then a
  429 puts the account on an in-memory cooldown (it honours `Retry-After`, else exponential backoff), the
  `failoverAccountNames` (more `openai-sub` logins, so subscriptions only) are tried in order within the same
  request, and a 401 after the refresh marks the account unhealthy for 15 minutes. `accounts list` shows the setting
  in its FAILOVER column, `config show` as `failover`.
- **Manual switch:** `tools ai-proxy session <id> use [--codex|--claude|--grok <account>]` changes the session record,
  and the next request runs on the new account with no restart. A login or a configured proxy account works; a
  per-token account needs `--allow-metered <account>`. Without a flag it lists the session's accounts and the ones it
  can use.
- **`baseUrl`** points the account (requests and the model list) at a WHAM-compatible endpoint instead of
  chatgpt.com, for example a fake upstream for an error test.
- **Parameters:** WHAM rejects `max_output_tokens`, `temperature` and `top_p`. The proxy strips them, warns once per
  process, and names them in the `x-ai-proxy-dropped` response header. The client's `reasoning` passes through and its
  effort is checked against the model's list. When the client sends none, `openaiSub.defaultReasoningEffort` applies
  (`"none"` omits the field), else the model's own default from the catalog, else `low`.
- **Aliases:** the built-ins `latest`, `codex` and `mini` resolve against the catalog; `openaiSub.aliases` adds
  per-account ones. Unknown ids pass through, so WHAM's own 400 reaches the client.
- **Usage:** `tools ai-proxy usage` reports the token counts the proxy saw. ChatGPT has no plan-quota endpoint, so
  weekly-limit numbers are never claimed.

#### xAI API key (`xai-api-key`)

An OpenAI-compatible passthrough to `https://api.x.ai/v1` (chat completions and Responses). `config detect` finds
`XAI_API_KEY` or `X_AI_API_KEY`. The model list comes from the live `GET /v1/models` (chat models only; image and video
models are filtered out), with a small static fallback when the request fails.

```json
{
  "name": "work",
  "provider": "xai-api-key",
  "providerSlug": "xai",
  "enabled": true,
  "apiKeyEnv": "XAI_API_KEY",
  "allowEnvApiKey": true,
  "managementKeyEnv": "XAI_MANAGEMENT_KEY",
  "teamId": "team-0000"
}
```

Usage numbers need Management API credentials (`managementKeyEnv` plus `teamId` or `XAI_TEAM_ID`); the inference key
alone has no usage endpoint.

#### OpenAI API key (`openai`)

An OpenAI API account, keyed by `OPENAI_API_KEY` by default. `config detect` does not add it; write the entry by hand
(`"provider": "openai"`, `"providerSlug": "openai"`), then give it a key with `accounts set-key` or `accounts
allow-env`. `/v1/chat/completions` and `/v1/responses` go to `api.openai.com/v1` unchanged (`baseUrl` overrides
it). The provider exists mainly for the realtime voice tunnel. `accounts test` and `usage` only confirm that a key is
present, because platform billing has no key-scoped usage endpoint.

#### OpenRouter API key (`openrouter`)

A relay to `https://openrouter.ai/api/v1/chat/completions`. `config detect` finds `OPENROUTER_API_KEY`;
`config init --append` adds it to a config that already has accounts. `/v1/responses` answers 501, because OpenRouter
serves no Responses API. `tools ai-proxy usage` reads the key-scoped `GET /api/v1/key`, so spend and the remaining
limit are real numbers.

```json
{
  "name": "router",
  "provider": "openrouter",
  "providerSlug": "openrouter",
  "enabled": true,
  "apiKeyEnv": "OPENROUTER_API_KEY",
  "allowEnvApiKey": true,
  "openrouter": {
    "models": { "include": ["anthropic/*", "openai/*"], "exclude": ["*:free"] },
    "provider": { "sort": "price" },
    "fallbackModels": ["qwen/qwen3.7-flash"],
    "routes": [
      { "match": "moonshotai/kimi-k3", "provider": { "order": ["Morph", "DeepInfra"], "allow_fallbacks": false } }
    ]
  }
}
```

**Model ids.** The canonical form has four segments: `router/openrouter/anthropic/claude-sonnet-5.5`. Two shorter
forms resolve too: `openrouter/anthropic/claude-sonnet-5.5` (provider-slug shorthand) and the bare
`anthropic/claude-sonnet-5.5`. The bare form is catalog-gated: it resolves only for ids OpenRouter serves, so
`xai/grok-4.5` still fails locally instead of becoming an upstream 404 on a billed key.

**The `models` filter** governs `/v1/models` only, never what can be called:

| Setting | Meaning |
|---|---|
| no `include` | the curated vendor default (anthropic, openai, google, x-ai, deepseek, qwen, ...) |
| `include: ["*"]` or `[]` | every model OpenRouter serves |
| no `exclude` | `["*:free"]`: free routes are rate-limited and use donated capacity |
| `exclude: []` | nothing excluded |

The five router pseudo-models priced at `-1` (`openrouter/auto`, `auto-beta`, `fusion`, `pareto-code`,
`bodybuilder`) are always dropped, because they cannot be priced.

**Body merge: the client wins.** The proxy injects `usage: {include: true}` (plus `stream_options.include_usage` when
streaming), so the ledger books OpenRouter's own reported charge instead of an estimate. `provider` and
`fallbackModels` are injected only for top-level keys the client did not set; a client's own `provider` block reaches
the upstream verbatim. `openrouter.reasoning` defaults to `{ enabled: true }`: a reasoning model bills its thinking
tokens either way, and OpenRouter omits them from the response unless asked. `{ exclude: true }` keeps the tokens but
drops them from the response.

**Per-model routing.** `openrouter.routes[]` overrides `provider` and `fallbackModels` for specific upstream ids,
checked in array order; the first match (an exact id or a trailing `*`) wins. One account can pin a strict route for
the model that needs it while every other model keeps open, cheapest routing. Without `routes`, `provider` applies to
every model and can 404 models the pinned providers do not serve. Precedence: the client body, then the first
matching route, then the account's `provider` and `fallbackModels`, then OpenRouter's own default. Each route field
falls back to the account default on its own: a route that names only `provider` still uses the account's
`fallbackModels`.

**Setting routing from the CLI.** `accounts set-routing` writes `openrouter.provider` and `fallbackModels`, or one
entry of `routes[]` with `--match`:

```bash
# account-level default (no --match)
tools ai-proxy accounts set-routing router --order Morph,DeepInfra,Fireworks --no-allow-fallbacks
tools ai-proxy accounts set-routing router --ignore Chutes,Together --sort price
tools ai-proxy accounts set-routing router --fallback-models qwen/qwen3.7-flash,deepseek/deepseek-v4-flash
tools ai-proxy accounts set-routing router --clear

# one per-model route (added or updated by its exact match string)
tools ai-proxy accounts set-routing router --match "moonshotai/kimi-k3" --order Morph,DeepInfra --no-allow-fallbacks
tools ai-proxy accounts set-routing router --match "deepseek/*" --sort price
tools ai-proxy accounts set-routing router --match "moonshotai/kimi-k3" --clear
```

All flags: `--match <glob>`, `--order <providers>`, `--only <providers>`, `--ignore <providers>`,
`--sort price|throughput|latency`, `--allow-fallbacks` / `--no-allow-fallbacks`, `--require-parameters` /
`--no-require-parameters`, `--data-collection allow|deny`, `--fallback-models <ids>`, `--clear`. The list flags take
comma-separated values. Each flag patches only the field it names and leaves the rest (and the `models` filter) alone.
`--clear` without `--match` removes the account-level pin and keeps the `models` filter and `routes`; with `--match` it
removes only that route.

> ⚠️ OpenRouter is a non-subscription provider, so a client with no `allowedProviders` ("all non-subscription
> providers") gets this account's billed key. Scope the client, or bound it with `monthlyCostCapUsd`.

Live verification (🛑 spends real money):

```bash
bun src/ai-proxy/scripts/verify-openrouter-live.ts --models 20 --images
```

It runs every model on both surfaces (plugin and relay) inside a temp `GENESIS_TOOLS_HOME`, and prints the
upstream-reported cost next to the catalog's derived cost per row. That delta column is how the pricing module is
checked against ground truth.

#### API keys and the environment

An api-key account (xAI, OpenAI, OpenRouter) takes its key in this order: a key stored on the account (`apiKey`), the
variable the account names (`apiKeyEnv`), the provider's default variable. An environment key is spent only when the
account has `allowEnvApiKey: true`; otherwise the request is refused with a message that names `set-key` and
`allow-env`. A key that merely sits in your shell is never spent by surprise. Accounts written by `config init` do not
set the opt-in, so run `tools ai-proxy accounts allow-env <name>` or `accounts set-key <name>` after it.

### Claude Code and Anthropic clients (`/v1/messages`)

```bash
tools claude proxy alice/grok -m 4.5        # pick a model, then launch Claude Code on it
tools claude run alice/grok/grok-4.5        # the same; a slashed name means an ai-proxy target
tools claude proxy work/xai --list          # list what that account serves
tools claude codex                          # Claude Code on Codex models, with its own session key
```

Point any client at it by hand:

```text
ANTHROPIC_BASE_URL=http://127.0.0.1:8317
ANTHROPIC_AUTH_TOKEN=<proxyApiKey>      # x-api-key works too
ANTHROPIC_MODEL=alice/grok/grok-4.5
```

How a request travels (`lib/anthropic-messages.ts`):

- On the chat hop the request is normalized down to OpenAI chat/completions (`system` becomes a system message,
  `tools[].input_schema` becomes `function.parameters`, `tool_result` becomes `role: "tool"`), then routed to the
  account like any other request. The answer is translated back: a completion becomes an Anthropic message, and an
  OpenAI stream becomes `message_start`, `content_block_*`, `message_delta` and `message_stop` frames.
  `reasoning_content` becomes real `thinking` blocks, with no `signature`.
- **Usage rows book the OpenAI-shaped exchange**, not the Anthropic frames, so billing and the call timeline stay on
  the one shape they parse.
- Upstreams that report no streaming usage (Grok drops `stream_options`) get an estimate instead of `0`, so Claude
  Code's context meter and auto-compact still work.
- **The Codex and Grok agents skip the chat hop.** Their `/v1/messages` goes straight to the Responses wire
  (`translators/formats/anthropic/anthropic-to-responses.ts` and its mirror), so encrypted reasoning survives a turn:
  it rides in the thinking block's `signature`, which Claude Code replays verbatim. Codex stamps it as
  `gtr1.codex.<accountHash8>.<model>.<compHash>.<payload>` (`reasoning-envelope.ts`). A later turn replays only
  envelopes of the same account and `comp_hash`, in their original order, and silently drops every other one. A 400
  about a replayed blob is retried once without reasoning, and that blob is not sent again. Claude Code's compaction
  turn goes out with `tool_choice: "none"`. Reasoning summaries show as thinking text, never as visible text
  (`openaiSub.reasoningSummary`: `auto` by default, `detailed`, `none`). `AI_PROXY_CODEX_MESSAGES_ROUTE=chat` restores
  the chat hop for Codex, as `AI_PROXY_GROK_MESSAGES_ROUTE=shim` does for Grok.
- **WebSearch** (Anthropic's `web_search_20250305` server tool) runs on the upstream's own hosted search: xAI's
  `web_search` on Grok, OpenAI's `web_search` on Codex (`filters.allowed_domains` for an allow-list). Each search comes
  back as `server_tool_use` plus `web_search_tool_result` with its real titles and URLs, then the answer, which is what
  Claude Code's WebSearch reads. A request the hosted search cannot carry (client tools, tool results, images,
  exclusions on Codex), or a hosted search that fails, takes the Brave loop when `BRAVE_API_KEY` is set. Claude Code
  2.1.296 sends WebSearch's request to the haiku slot, so in `tools claude codex` with a Claude account Anthropic runs
  the search; with `--claude none` the Codex hosted search does. WebFetch's page pass goes to the same slot.

Caveats: `count_tokens` is a 4-characters-per-token estimate by choice. The Claude subscription upstream has a real
counter, but proxying to it costs a round trip per turn and is untested against a subscription grant. A model whose
catalog entry says `supportsTools: false` cannot edit files; `tools claude proxy` warns before it launches one.

#### Session records

`tools claude codex` creates one record per Claude Code session in `~/.genesis-tools/ai-proxy/sessions/<id>.json`
(file 0600, folder 0700). The `<id>` is Claude Code's own session id, so the record, the request tags, the transcript
file and the upstream cache key all carry one id. The record stores only a SHA-256 of the session key. Closed records
are deleted after `sessionRetentionDays` (default 30). `sessions`, `session <id>`, `stats` and `monitor` read them.

#### Compaction and other Claude Code session settings

Claude Code sessions read `sessionsIn.claude` in `config.json` (every field is optional). It has two levels: `global`
for Claude Code itself, and `providers.codex` / `providers.grok` for the provider of the session's models. The proxy
reloads compaction settings on each request. Lead notes, subagent notes and skill settings take effect on launch or
resume.

- `providers.codex.compaction.mode`: default `"native"`, Codex's own server-side compaction: the turn's request plus a
  `compaction_trigger` item, at the session's effort on its cached prefix. Claude Code keeps a
  `[codex-compaction gtc1.<id>]` marker. The proxy stores the encrypted item and the compacted history in
  `ai-proxy/compactions/<id>.json` and restores the item on later requests. Another Codex login compacts the saved
  history once more. If the native response has readable text, the marker keeps it as a fallback; the proxy does not
  make a second request to create one. If the restore fails and there is no readable text, the proxy rejects the turn
  with a 400 rather than lose context. The error names both ways on:
  `tools ai-proxy session <id> compaction-restore --marker <gtc1-id> --from <record-file>` puts a saved record back,
  and `tools ai-proxy session <id> compaction-drop --marker <gtc1-id> --acknowledge-context-loss` lets that one session
  continue without it (the note becomes one plain line; send the missing context in the next message). Without a
  session key, put the record back or start a new session with a readable handoff. Summary mode cannot recover history
  from an unrestorable marker, so set the mode to `"summary"` before you switch providers. `"summary"` makes one
  written-summary request (`effort`, `words` below); it is also the fallback when a native compaction returns no item.
- `providers.codex.compaction.effort`: the effort of Claude Code's compaction turn, default `"session"` (the session's
  own). Each effort level has its own prompt cache, so another effort re-reads the whole context uncached (428K tokens
  on 2026-10-27). Set one only when speed matters more than the cache.
- `providers.codex.compaction.words`: the summary length asked for, default `5000`; `0` asks for no limit.
- `providers.grok.compaction.words`: Grok has no server-side compaction, so its model writes Claude Code's summary.
  Set a length to ask for one; by default the compaction prompt goes up as Claude Code wrote it.
- `global.compaction.idle` (default `true`): `tools claude codex` sets Claude Code's `promptCacheTtl` to `"1h"`. Claude
  Code arms its idle compaction only after a main request that used the one-hour cache, and through the proxy it
  otherwise asks for five minutes, so without this the idle compaction never runs. Takes effect on launch or resume.
- `providers.codex.compaction.background` (native mode, `tools claude codex` sessions only): Codex's
  `async_compaction`. When a turn's context reaches `startAt` (default `0.8`) of the session's compaction point (window
  times compact percent), the proxy compacts that turn in the background. Claude Code's compaction turn (auto,
  `/compact`, or idle compaction near the cache's expiry) is then answered at once, and the turns after the background
  point stay verbatim behind the item. A run in flight is awaited, never repeated. A new run starts when the context
  grew by `refreshFraction` (default `0.15`) of the compaction point. The result is not used when another login made
  it, when the history before it changed (a rewound or edited turn), or when more than `maxTailFraction` (default
  `0.4`) came after it. The turn then compacts the normal way, the summary says why, and the next request carries a
  one-time reminder so the agent tells the user in its next reply (`background-wasted` in the events). Set
  `enabled: false` to turn it off. Claude Code's own background compaction ("precomputed compaction") needs a server
  flag that was off on 2026-10-28; when it sends its compaction turn early, the same path answers it.
- `global.lead.systemNote` and `providers.codex.subagents.systemNote`: `{ prepend, append, replace }` around the note
  `tools claude codex` gives the main loop and its Codex subagents. `replace` drops the built-in text.
- `providers.codex.subagents.skills.nudge` (default `true`): the lead names in each brief the skills a subagent loads,
  and the subagent loads only those. `providers.codex.subagents.skills.allowed`: the list the lead picks from (absent:
  any skill).
- `providers.codex.execTool` (default `true`): a request whose tools include Claude Code's `Bash` also offers Codex's
  own `exec` tool, a JavaScript script that calls `await tools.exec_command({ cmd })` and `text(...)`, so a chain of
  dependent commands costs one model call. The proxy sends a call as one `Bash` call that pipes the script through a
  quoted heredoc into `src/ai-proxy/lib/providers/codex/exec/runner.ts` of the proxy's checkout, and sends it back to
  the model as the `custom_tool_call` it made, so the prompt cache holds. The runner puts every nested command through
  the `tools agents hooks` shell guard (a block is an error the script sees), prints Codex's `Script completed`
  header, and keeps the output under Claude Code's 30,000-character Bash limit. `store` and `load` keep values per
  Claude Code session in `ai-proxy/exec-store/<session>.json`. The tool is in `tools` from the first request, so
  turning the setting on or off reads the prompt cache once at 0%. The lead note names it while it is on; that part
  takes effect on launch or resume, the tool on the next request.

A `claudeSessions` block from before 2026-10-28 moves into `sessionsIn.claude` on load (`idle` and `lead` to `global`,
the rest to `providers.codex`), and the next save drops it.

### Data on disk

Everything lives under `~/.genesis-tools/ai-proxy/`:

| Path | What it holds |
|---|---|
| `config.json` | The config (file mode 0600). |
| `runtime.json`, `proxy.pid` | The running proxy and tunnel. |
| `proxy.log` | The server's output, every line timestamped. |
| `tunnel.log` | The cloudflared tunnel's output. |
| `models-catalog.json` | This account's model probe results. Never committed. |
| `usage/requests.jsonl` | One line per request: model, latency, status, tokens. |
| `usage/daily.json` | Today's rollup by account and model. |
| `usage/billing.json` | Cached subscription billing snapshots (5 minute TTL). |
| `usage/clients.json` | The per-client monthly ledger. |
| `usage/compaction-events.jsonl` | One line per compaction event. |
| `sessions/<id>.json` | Claude Code session records. |
| `compactions/<id>.json` | Saved native Codex compactions. |
| `exec-store/<session>.json` | Values the Codex `exec` tool stores. |
| `transcripts/` | The full prompt and response of every exchange. Not redacted. |
| `debug/last-<provider>-failure.json` | The last failing upstream exchange, with `AI_PROXY_DEBUG_CAPTURE=1`. |

- Compaction event kinds: `turn`, `done` (with the client's wait), `retry` (Claude Code asked for the summary again),
  `missed` (a compaction prompt that was not read as one), `background-start`, `background-ready`,
  `background-failed`, `background-used`, `background-wasted`, `recompacted`, `blocked`, and `cache-reset` (a Codex
  thread changed its effort or model, so it re-read the context uncached).
- Transcripts are on by default, because they are the only evidence after the fact. Whatever a prompt carried (file
  contents, keys pasted into a message, tool arguments) lands on disk verbatim; the folder is 0700 and the files 0600.
  `AI_PROXY_TRANSCRIPTS=0` turns them off.
- ⚠️ The debug capture can hold a credential. Only the ChatGPT subscription provider writes it, and only with
  `AI_PROXY_DEBUG_CAPTURE=1`. It stores the account name, the model, the status, the full request body sent upstream
  and the upstream error text, with no redaction. It leaves out the request headers, so the account's
  `Authorization` token and the proxy key are not in it. Anything inside the body is: a key pasted into a prompt, a
  secret in a file or a tool result, or one that the upstream error repeats. The file is `0600` in a `0700` folder,
  so other users of this Mac cannot read it. Delete it when you are done. Before you share any part of it, the error
  text included, search that part for secrets and redact them: an upstream error can repeat a secret from the request.
- The data stays on this Mac. To reset the request history, truncate or delete `usage/requests.jsonl` (and
  optionally `usage/daily.json`). `tools ai-proxy usage --paths` prints the paths.
- Every booking is also mirrored into the shared GenesisTools usage layer, which never throws, so a failure there
  cannot break a request. An unpriced row gets a catalog estimate there, tagged `costSource: "catalog"`.

### Running as a launchd agent (macOS)

`tools ai-proxy up` alone gives you a detached process that dies at reboot and never comes back. On 2026-08-31 that
cost ten silent days: the proxy had been down since 2026-08-21, and the only symptom was `ECONNREFUSED
127.0.0.1:8317` inside two MCP servers whose plain API tools kept working.

```bash
tools ai-proxy install     # write and load ~/Library/LaunchAgents/com.genesis-tools.ai-proxy.plist
tools ai-proxy uninstall   # unload and delete it (the proxy stops)
```

- Label: `com.genesis-tools.ai-proxy`. `RunAtLoad` and `KeepAlive` are both true, so it starts at login and respawns
  on crash. stdout and stderr go to `~/.genesis-tools/ai-proxy/proxy.log`.
- The plist carries `HOME`, `PATH` and the `LANG` / `LC_*` locale only, **no API keys**. The proxy reads the Grok
  login from `~/.grok/auth.json` (hence `HOME`) and every other credential from `config.json` and the encrypted vault.
  An account that relies on an environment key fails under launchd; store its key with `accounts set-key`.
- With the agent installed, `up` kickstarts it instead of spawning a second process, and **`down` boots the agent out
  first**. Otherwise `KeepAlive` answers the SIGTERM by restarting the proxy two seconds later. `status` prints
  whether launchd owns the proxy.
- `down` never stops the shared cloudflared tunnel, on either path. Other routes on the same hostname (the
  dev-dashboard) keep running.

### Public exposure

`public.mode` decides how a remote client (Cursor in the cloud) reaches the proxy. `config setup-tunnel` asks which
mode you want and writes it:

- `none` (default): local only.
- `cloudflared`: `config setup-tunnel` walks through the tunnel and offers `brew install cloudflared` when it is
  missing. `up` starts the tunnel when `cloudflared.autoStart` is true. The tunnel's ingress rule routes only
  `/<basePath>/v1` and `/<basePath>/health`, so other paths on the same hostname stay with their own service.
- `tailscale`: your tailnet hostname (`public.hostname` or `public.tailscale.hostname`). `config setup-tunnel` asks
  for the MagicDNS hostname and the path prefix. No tunnel process is managed.
- `custom`: a full base URL in `public.baseUrl`, which `config setup-tunnel` asks for (it must end with `/v1`). No
  tunnel process is managed.

`up` checks the public `/health` after the start and prints whether it answered.

### Cursor BYOK

```text
Override OpenAI Base URL: https://<hostname>/ai/v1      (or local http://127.0.0.1:8317/v1)
API Key: <proxyApiKey from config>
Model: alice/grok/grok-composer-2.5-fast
Model: alice/github-copilot/claude-sonnet-4
```

`tools ai-proxy introspect --section cursor` prints these values. Start with `--translate-cursor auto`. If Agent mode
breaks, try `--no-translate` or `--translate-cursor on`. `--thinking` decides how reasoning reaches Cursor: `raw`
passes it through, `cursor` (default) sends `reasoning_content` only for Cursor's thinking UI, `folded` puts it in a
`<details>` block in the content.

### Client keys and billing

Multi-user (VPS) mode, added 2026-07: each downstream user gets its own key in `clients`, while `proxyApiKey` stays
the owner key.

```json
"clients": [
  { "name": "team-bot", "key": "<vault ref or 32+ char secret>", "monthlyTokenCap": 5000000, "monthlyCostCapUsd": 25 }
]
```

- **No-resale invariant:** a client key can never route to a subscription provider (Grok, Copilot, Claude, Codex
  subscriptions). Only the owner key can. A client's attempt gets
  `403 {"type":"forbidden","code":"provider_not_allowed"}`, and a config that grants a subscription provider to a
  client refuses to boot.
- **Scope:** `allowedProviders` (set with `clients add --provider`) lists the provider types a client may use.
  Omitted means every non-subscription provider.
- **Quotas:** `monthlyTokenCap` and `monthlyCostCapUsd` are enforced per UTC month against `usage/clients.json`. An
  over-cap request gets `429 {"type":"quota_exceeded","code":"monthly_quota_exceeded"}`. The caps apply to the
  realtime WebSocket too.
- **Keys:** `clients add` stores the key in the vault (`ai-proxy/clients/<name>/key`) and prints it once. A config
  written before the vault existed holds literal keys; `clients secure` moves them in.
- **Invoices:** `clients usage --csv` is the v1 invoicing export.
- **One key per service:** a service such as eve (`apps/eve`) connects as one client key (for example `eve-service`)
  with its own caps. Set that key as the service's OpenAI-compatible API key, with the proxy as its base URL.
  Splitting its traffic per end user is a later plan.

### What costs money

- Subscription accounts spend your plan's quota. API-key accounts (xAI, OpenAI, OpenRouter) bill per token.
- The ledger books cost at write time from `lib/billing/pricing.ts`, a static table that is the invoicing source of
  truth. A later rate edit never rewrites a past invoice; readers print the stored `cost_usd`.
- ⚠️ **Pricing does not auto-discover.** A new model has no row in `lib/billing/pricing.ts`, and that table matches ids
  exactly (never by prefix: a prefix match once billed grok-4.5 at grok-4's 7.5x rate). One fallback exists: an id
  with no row of its own that ends in `-YYYYMMDD` or `-latest` is looked up again without that suffix, so
  `<model>-20260115` and `<model>-latest` book at `<model>`'s rate, not $0. An unpriced model (no row for the id or
  for its base) records its tokens, books **$0**, and is marked in the CLI. That fails safe rather than mis-billing. Listing an unpriced model is
  silent; the warning that names the id and the file is logged from `recordClientUsage`, once per unpriced call that
  is recorded. So an unpriced id is noticed when it costs money, not when it appears in a model list.
- The `verify-*-live.ts` scripts in `scripts/` call real upstreams.

### Where model knowledge lives

Three tiers, and only the middle one belongs in git:

| Tier | Where | Committed |
|---|---|---|
| Live picker | `~/.grok/models_cache.json` (the grok CLI refreshes it) | no |
| Curated hints, probe seeds | `GROK_STATIC_CATALOG` in `src/utils/ai/grok/models.ts` | yes |
| This account's probe results | `~/.genesis-tools/ai-proxy/models-catalog.json` | no |

`listGrokProxyModels` merges all three, live first, so **a model xAI ships tomorrow is offered without a repo edit**:
the grok CLI refreshes its own cache and the id appears. The static list still matters: `GROK_PROBE_CANDIDATES` is
seeded from it, so an id missing there is never probed.

`models-catalog.json` is written by `tools ai-proxy internal update-models` and is per user: it records which ids your
account's probe reached, keyed by your account name, so it was never shareable. Only grok and github-copilot use it.
Every other provider lists live and needs no stored catalog: `xai` and `openai` through `GET /v1/models`, `codex`
through the WHAM model list, `openrouter` through its live catalog. `claude-sub` has no model endpoint and uses fixed
aliases.

```bash
tools ai-proxy internal update-models --account alice
tools ai-proxy internal update-models --provider github-copilot --dry-run
```

## Configuration

`~/.genesis-tools/ai-proxy/config.json`. Change it with `config set`, the `accounts` and `clients` commands, or by
hand. `config show` prints it redacted. Top-level keys:

| Key | Default | Meaning |
|---|---|---|
| `listen` | `{ host: "127.0.0.1", port: 8317 }` | Where the server listens. |
| `proxyApiKey` | `aipx-<random>` | The owner key. |
| `translation.cursorAgent` | `auto` | Cursor request translation: `auto`, `on`, `off`. |
| `translation.thinking` | `cursor` | `raw`, `cursor`, `folded`. |
| `translation.thinkingRules` | none | Per-client rules on the User-Agent; first match wins. |
| `public` | `{ mode: "none", basePath: "/ai" }` | Public exposure, see above. |
| `accounts` | `[]` | Upstream accounts. |
| `clients` | none | Per-user keys and caps. |
| `realtime.allowClientSecrets` | `false` | Allow minting realtime secrets for direct vendor calls. |
| `modelOverrides.codex.<slug>` | none | Per Codex model: `window`, `usablePercent`, `compactPercent`, `defaultEffort`. |
| `sessionRetentionDays` | `30` | Days a closed session record is kept. |
| `sessionsIn.claude` | none | Claude Code session settings, see above. |

- `translation.thinkingRules` example: `[{ "uaRegex": "Cursor", "mode": "cursor" }, { "catchAll": true, "mode":
  "auto" }]`. `auto` lets the route decide; on the chat route that is `raw`.
- `realtime.allowClientSecrets` is off by default because a minted secret talks to the vendor directly, so that
  session never passes through the proxy and cannot be logged.
- `modelOverrides.codex` values win over the live list, the Codex CLI cache and the static table. The proxy uses
  `defaultEffort`; `tools claude codex` uses the rest. A `codexModels` block from before 2026-10-28 moves there on load
  (a model `modelOverrides.codex` already sets keeps its values), and the next save drops it.
- Common account keys: `name`, `label`, `provider`, `providerSlug`, `enabled`, `failover`, `account` (the
  `@account/<id>` ref), `apiKey`, `apiKeyEnv`, `allowEnvApiKey`, `baseUrl`, `realtimeBaseUrl`, `managementKeyEnv`,
  `teamId`, plus one provider block (`grok`, `githubCopilot`, `anthropicSub`, `openaiSub`, `openrouter`).

Environment variables:

| Variable | Effect |
|---|---|
| `AI_PROXY_TRANSCRIPTS=0` | Do not write `transcripts/`. |
| `AI_PROXY_DEBUG_CAPTURE=1` | Save the last failing upstream exchange under `debug/`. |
| `AI_PROXY_CODEX_MESSAGES_ROUTE=chat` | Codex `/v1/messages` through the chat hop. |
| `AI_PROXY_GROK_MESSAGES_ROUTE=shim` | Grok `/v1/messages` through the native passthrough. |
| `AI_PROXY_CODEX_ALL_TURNS=0` | Stop sending `reasoning.context: "all_turns"` to Responses Lite Codex models. |
| `AI_PROXY_REASONING_REPLAY=drop` | Test switch: send every turn without earlier reasoning. |
| `BRAVE_API_KEY` | Enables the Brave fallback for WebSearch. |
| `XAI_API_KEY`, `X_AI_API_KEY`, `XAI_MANAGEMENT_KEY`, `XAI_TEAM_ID` | xAI detection and usage. |
| `OPENAI_API_KEY`, `OPENROUTER_API_KEY` | Default key variables (spent only with `allowEnvApiKey`). |
| `COPILOT_API_HOME` | Moves the Copilot data folder. |
| `COPILOT_GITHUB_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_PERSONAL_ACCESS_TOKEN` | Copilot's GitHub token when the data folder has none. |

## For agents

- `--json`: `status`, `install`, `uninstall`, `models`, `introspect`, `usage`, `sessions`, `session`, `stats`,
  `calls`, and `monitor` (one object per line). `clients usage` prints JSON by default.
- `tools ai-proxy monitor` is built for a Monitor tool: one line per request or event, filtered with `--session`,
  `--errors` and `--compaction`.
- Tag your requests with `x-gt-session`, `x-gt-stage`, `x-gt-label` and `x-gt-run` headers, then find them with
  `tools ai-proxy calls --session <id> --show` or `--timeline`.
- `tools ai-proxy link` lets every GenesisTools AI call reach the proxy with a model ref such as
  `@proxy/grok/grok-4.5`. The proxy key goes into the vault; the AI config holds a pointer.
- Exit code 1 comes from a failed `link`, an unknown `session` action, `session <id>` with no record, a refused
  `session <id> use`, `compaction-restore` or `compaction-drop`, a failed `clients` command, `accounts failover` and
  `accounts bind`. Many other failures exit 0: `accounts test` (an unknown account or a failed upstream test),
  `accounts enable`, `disable`, `remove`, `set-key`, `allow-env`, `set-routing`, `accounts login` with an unknown
  provider, and `config set` with a bad `--thinking` value. A caller must read their output, not the exit code.
- A health check from a shell with a proxy configured needs `curl --noproxy '*' http://127.0.0.1:8317/health` (or
  unset `http_proxy` / `https_proxy`).

## Troubleshooting

- **`ECONNREFUSED 127.0.0.1:8317`**: the proxy is not running. `tools ai-proxy status`, then `tools ai-proxy install`
  so it survives a reboot.
- **`Port 8317 already in use by pid N`** from `up`: another program holds the port. Stop it, or move the
  proxy with `tools ai-proxy config set --port <n>`.
- **The proxy comes back after `kill`**: the launchd agent's `KeepAlive` restarts it. Use `tools ai-proxy down` (it
  boots the agent out first) or `tools ai-proxy uninstall`.
- **`Refusing to spend the ambient XAI_API_KEY ...`**: the account has no stored key and no env opt-in. Run
  `tools ai-proxy accounts set-key <name>` or `tools ai-proxy accounts allow-env <name>`.
- **A config change does nothing**: account edits apply on the next request, so this is one of the restart cases: a
  new `listen.port`, `listen.host` or `public.basePath`, a `serve` flag, or a new value of an environment variable.
  Restart with `tools ai-proxy down && tools ai-proxy up`.
- **A Codex turn fails with a 400 about a compaction marker**: the native compaction could not be restored. Follow
  the two commands the error names (`session <id> compaction-restore` or `compaction-drop`).
- **A model costs $0 in the ledger**: it has no row in `lib/billing/pricing.ts`. See "What costs money".
- **`proxy.log` looks quiet**: check the timestamps on its lines. A stale file and a quiet proxy look the same
  without them, which once derailed an incident investigation on a 5-day-old log.
- **A failing upstream you need to see**: rerun with `AI_PROXY_DEBUG_CAPTURE=1` and read
  `~/.genesis-tools/ai-proxy/debug/last-<provider>-failure.json`, or open the call with `tools ai-proxy calls --show`.

## Related

- [tools claude](../claude/README.md): `tools claude proxy`, `run` and `codex` launch Claude Code through this proxy.
- [tools codex](../codex/README.md): Codex logins (`tools codex login`) and `tools codex models`.
- [tools ai](../ai/README.md): the shared AI config, accounts and the vault this proxy links to.
- [tools ask](../ask/README.md): another client of the shared AI config.
- [REALTIME.md](REALTIME.md): the `/v1/realtime` WebSocket and audio.
