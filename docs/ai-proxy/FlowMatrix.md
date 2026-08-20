# ai-proxy flow matrix

Which inbound door reaches which upstream, in which wire shape, and what is lost on the way.

**Measured 2026-08-19** by `src/ai-proxy/lib/flow-matrix.live.test.ts`. Every measured cell was
executed against the live upstream, not inferred; github-copilot has no account on this machine
and is marked *not measured* for that reason. Re-run it after touching any translator:

```bash
tools ai-proxy up   # the test talks to the running proxy
RUN_LIVE_SMOKE=1 GENESIS_TOOLS_TEST_ALLOW_REAL_HOME=1 \
  bun run test src/ai-proxy/lib/flow-matrix.live.test.ts
```

🛑 **`GENESIS_TOOLS_TEST_ALLOW_REAL_HOME=1` is not optional.** Without it the suite's throwaway
`~/.genesis-tools` sandbox hides your accounts and the test finds no models. It used to skip every
case and pass in under half a second; it now **fails** with `no provider/door pair ran`, because a
green run that finishes that fast has tested nothing.

## The two axes

**Inbound doors** — what a client may POST to the proxy:

| Door | Wire shape | Typical client |
|---|---|---|
| `/v1/chat/completions` | OpenAI Chat Completions | Cursor, `tools ask`, most SDKs |
| `/v1/responses` | OpenAI Responses | Cursor agent mode, Codex-style clients |
| `/v1/messages` | Anthropic Messages | **Claude Code**, Anthropic SDKs |
| `/v1/messages/count_tokens` | Anthropic | Claude Code's context meter |
| `/v1/models` | OpenAI | every client's model picker |
| `/v1/audio/transcriptions` | OpenAI | STT callers |
| `/v1/realtime`, `/v1/realtime/client_secrets` | OpenAI Realtime | realtime voice |

**Upstream shapes** — what each provider actually speaks:

| Provider (`providerSlug`) | Upstream | Native Anthropic? |
|---|---|---|
| `grok-subscription` (`grok`) | `/chat/completions`, `/responses` | **yes** — `/v1/messages` verified 200 |
| `anthropic-subscription` (`claude-sub`) | `api.anthropic.com/v1/messages` | **yes**, natively |
| `github-copilot-subscription` (`github-copilot`) | `/chat/completions`, `/responses`, `/v1/messages` | **yes**, via `resolveCopilotUpstreamRoute` |
| `openai-subscription` (`codex`) | WHAM `/responses` (streaming only) | no |
| `xai-api-key` (`xai`) | `/chat/completions`, `/responses` | no |
| `openai-api-key` (`openai`) | `/chat/completions`, `/responses` | no |
| `openrouter` (`openrouter`) | `/chat/completions` only | no |

## Measured results

Prompt: `Think about what is 2+2= and give me only the result`. `ok` means HTTP 200 **and** a `4`
in the body.

| Provider | `/v1/chat/completions` | `/v1/responses` | `/v1/messages` |
|---|---|---|---|
| grok | ok | ok | ok |
| xai | ok | ok | ok |
| claude-sub | ok | **400 by design** | ok |
| codex | ok | ok | ok |
| openrouter | ok | **501 by design** | ok |
| github-copilot | *not measured* | *not measured* | *not measured* |

The two failures are deliberate, not defects: `anthropic-subscription` and `openrouter` have no
Responses API upstream and say so explicitly rather than faking one.

⚠️ **github-copilot has no configured account on this machine**, so its row is untested. Its code
paths exist and `resolveCopilotUpstreamRoute` already prefers the native `/v1/messages` route for
Anthropic-shaped bodies — see the known gap below.

## Translation paths

### Anthropic in, Anthropic upstream — passthrough (no reshape)

Used when the provider implements `ProxyProvider.messages()`. Today: `anthropic-subscription`
and `grok-subscription` (added 2026-08-19; preserves reasoning continuity — Grok accepts its own
`thinking` blocks replayed). The grok passthrough performs four spec repairs, not translations:

- `ensureToolRequiredArrays` — Grok rejects a tool whose `input_schema` omits `required`.
- `hoistSystemMessages` — Claude Code sometimes puts a `role:"system"` entry inside `messages[]`;
  Grok answers `Invalid message role`. Anthropic rejects the same shape, so this runs on both
  passthroughs. Hoisted blocks are appended after the existing `system` array, leaving
  `cache_control` breakpoints in place.
- `stringifyUnknownToolResultBlocks` — ⚠️ the one **lossy** repair. Grok's deserializer 422s the
  whole request on block types it does not know inside `tool_result.content` (ToolSearch results
  carry `{type:"tool_reference"}`), so those blocks become `text` blocks holding their own JSON.
  Nothing is dropped, but the block's original type is no longer structured.
- `repairAnthropicSseIndices` — Grok reuses `index: 0` for every content block and omits it on
  deltas (Anthropic SDKs would overwrite the thinking block with the text block), and it merges
  several parallel tool calls into ONE `tool_use` block. The extra calls are re-emitted as their
  own blocks, each named by matching its argument keys against the request's tool schemas.

```text
Claude Code --Anthropic--> /v1/messages --Anthropic (verbatim)--> api.anthropic.com
```

**Why it exists.** The reshape below drops every field the OpenAI schema has no slot for.
`cache_control` is the expensive one: Anthropic caches **only** at explicit breakpoints, so
stripping them disables prompt caching outright. Measured on one real 37k-token Claude Code
request:

| Path | run 1 | run 2 | run 3 |
|---|---|---|---|
| translated | `cache_read: none` | `cache_read: none` | `cache_read: none` |
| passthrough | `cache_create: 19866` | `cache_read: 19866` | `cache_read: 19866` |

Two rules this path must keep:

- **`system` stays an ARRAY.** Flattening it to a string removes the breakpoints. Claude Code's
  `system[0]` already is the subscription prefix, so the usual case forwards byte-identical.
- **The client's `anthropic-beta` header is merged in.** Claude Code always sends
  `context_management`, which Anthropic rejects with a 400 unless
  `context-management-2025-06-27` is advertised.

### Anthropic in, OpenAI upstream — translated

Everything else on `/v1/messages`.

```text
Anthropic --normalizeAnthropicToOpenAI--> OpenAI --provider--> upstream
upstream --openai-to-anthropic-responses--> Anthropic SSE --> client
```

Known losses, all deliberate:

| Dropped | Where | Consequence |
|---|---|---|
| `cache_control` | `sanitizeContentPart` | none on Grok (caches implicitly, measured 32.5k hits); fatal on Anthropic |
| `thinking` (request) | `transformAnthropicFields` | the client's thinking toggle never reaches the upstream |
| assistant `thinking` blocks (history) | `transformMessages` | **reasoning continuity is lost across turns** — deliberate here; providers whose upstream speaks Anthropic natively must implement `messages()` instead |
| `context_management`, `metadata`, `anthropic_version`, `top_k` | `transformAnthropicFields` | none — no OpenAI equivalent |
| thinking `signature` | never synthesized | none; Grok itself returns `signature: ""` |

No longer dropped (fixed 2026-08-19): `output_config.effort` → `reasoning_effort`,
`output_config.format` → `response_format.json_schema`, `tool_result.is_error` → a
`[Tool call failed]` prefix on the tool message, and images now translate to `image_url`
uniformly (the `[Image Omitted]` special case for claude-named models is gone).

### OpenAI in — unchanged

`/v1/chat/completions` and `/v1/responses` behave exactly as before `/v1/messages` existed.
Cursor is unaffected by any of the above.

## Known gaps

1. **Copilot's native messages route is unreachable from `/v1/messages`.**
   `resolveCopilotUpstreamRoute` picks `/v1/messages` only `if (isAnthropicShapedBody(body))`, but
   the Anthropic door normalizes to OpenAI *before* the provider sees the body, so that test is
   always false and Copilot's Claude models fall back to `/chat/completions`.

2. **Sessions cannot be moved between grok and claude-sub mid-conversation.** Grok emits
   `signature: ""` on thinking blocks; Anthropic rejects those on replay with
   `Invalid signature in thinking block`.

## Upstream behaviour worth knowing

- **Grok stalls ~15.4s before the first byte on roughly 1 call in 3**, on every endpoint, and on
  raw curl that never touches this proxy. The tell is an SSE comment `: keepalive` arriving first.
  Not ours; see `messages.upstream-first-content` in the profiler (`PROFILE=ai-proxy`).
- **Grok's `/v1/messages` reports Anthropic-shaped usage**, including
  `cache_creation_input_tokens` / `cache_read_input_tokens`.
