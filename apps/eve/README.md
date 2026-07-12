# GenesisEve (eve foundation)

An isolated [eve](https://github.com/vercel/eve) agent. It bills a **subscription**
(via the local `ai-proxy`), persists durably to a swappable world, and can call the
local `tools youtube` server.

> Runs on Node 24 + eve's own dependency tree. It is NOT part of the root Bun
> workspace — it has its own `package.json`/`node_modules`. Run everything from
> inside `apps/eve/`.

## Prerequisites

1. `tools ai-proxy up` — the subscription proxy on :8317. Put its `proxyApiKey`
   (`~/.genesis-tools/ai-proxy/config.json`) into `.env` as `AI_PROXY_API_KEY`.
2. (For YouTube tools) `tools youtube server start --port 9876`.
3. `cp .env.example .env` and fill it in.

## Run

```bash
cd apps/eve
bun x eve dev            # dev server + TUI on http://127.0.0.1:2000
# or, self-host the production build under Bun:
bun x eve build && PORT=2100 bun .output/server/index.mjs
```

Create a session over HTTP:

```bash
curl -s -X POST http://127.0.0.1:2000/eve/v1/session \
  -H 'content-type: application/json' \
  -d '{"message":"List my youtube channels."}'
# → { sessionId, continuationToken }
# then stream: GET /eve/v1/session/<sessionId>/stream
```

## Switch the world

- **local (default):** nothing to do — durable JSON under `.workflow-data/`.
- **postgres:**
  ```bash
  docker compose -f infra/postgres.compose.yml up -d
  export EVE_WORLD=postgres
  export WORKFLOW_POSTGRES_URL=postgres://eve:eve@127.0.0.1:5433/eve
  export WORKFLOW_QUEUE_NAMESPACE=genesis-eve   # MUST equal the agent name
  bunx workflow-postgres-setup   # one-time schema init
  bun x eve dev
  ```

## Point at Claude / Codex

The model is whatever `EVE_MODEL_ID` names on `ai-proxy`. Grok works today. Once
ai-proxy Plan P0 adds `anthropic-subscription` / `openai-subscription` accounts,
set e.g. `EVE_MODEL_ID=claude-sub/sonnet` — no code change here.
