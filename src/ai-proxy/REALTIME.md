# ai-proxy realtime audio (`/v1/realtime`)

Real-time speech-to-speech through the proxy: a voice client opens ONE WebSocket
to ai-proxy and the proxy tunnels every frame — JSON events and binary audio
alike — to the upstream provider's OpenAI-Realtime-compatible WS (xAI
`wss://api.x.ai/v1/realtime`). Routing, auth, logging, and usage go through the
same machinery as the HTTP chat path; the protocol itself is not reinterpreted.

## Client-facing surface

```
ws://127.0.0.1:8317/v1/realtime?model=martin/grok/grok-voice-latest
```

- **Auth**: `Authorization: Bearer <proxyApiKey or client key>` — same keys as
  `/v1/chat/completions`. Browsers can't set WS headers; pass `?key=<key>`
  instead (only consulted when the header is absent).
- **Model**: the `model` query param takes a proxy model id
  (`<account>/<provider>/<model>`, shorter forms allowed) resolved by the same
  `resolveModel` as chat; the upstream leg gets the bare upstream id
  (`grok-voice-latest`) and the ACCOUNT's API key — the client never holds
  upstream credentials.
- **Protocol**: transparent tunnel. Send `session.update`,
  `input_audio_buffer.append`, `response.create`, binary PCM frames, …;
  receive `response.output_audio.delta`, transcripts, etc. verbatim.
- Client provider/quota rules apply exactly like chat (subscription providers
  stay owner-only; monthly caps reject the upgrade with 429).

Ephemeral-token mint for browsers that must talk to xAI directly:

```
POST http://127.0.0.1:8317/v1/realtime/client_secrets
Authorization: Bearer <proxy key>
{"session": {"type": "realtime", "model": "martin/grok/grok-voice-latest"}}
```

The proxy resolves the model, rewrites it (top-level `model` and
`session.model`) to the upstream id, and forwards to the provider's
`/realtime/client_secrets` with the account key. Note: a session opened with a
minted secret connects to the upstream DIRECTLY — it bypasses the proxy's
logging/usage. Prefer the WS tunnel when the client can reach the proxy.

## Batch STT: `POST /v1/audio/transcriptions`

OpenAI Whisper-compatible batch transcription for non-realtime use:

```
POST http://127.0.0.1:8317/v1/audio/transcriptions
Authorization: Bearer <proxy key>
multipart/form-data: model=martin/grok/grok-transcribe, file=<audio>, [language=…]
```

xAI has NO OpenAI-shape transcriptions route (404, verified live 2026-07-20) —
its STT is `POST /v1/stt` (multipart, no model field, `file` appended last).
The provider translates: `model` is consumed by proxy routing, remaining
fields + file forward to `/stt`, and the response (`{text, language, duration,
words}` — a superset of OpenAI's `json` format) passes through as-is. 25 MB
body cap (OpenAI's Whisper limit).

Relay gotcha fixed along the way: Bun's fetch decodes gzip upstream bodies but
keeps `Content-Encoding` on the headers; relaying them verbatim gave clients a
ZlibError. The xAI provider now strips stale framing headers on every relay.

## Provider support

Realtime is a provider capability (`realtimeConnect` / `realtimeClientSecrets`
on `ProxyProvider`), implemented by two providers. The upstream WS base
defaults to the account's `baseUrl` with `http(s)` swapped for `ws(s)`; set
`realtimeBaseUrl` on the account to override (this is how tests point it at a
mock server).

| Provider (config `provider`) | Upstream | Realtime models | Key |
|---|---|---|---|
| `xai-api-key` | `wss://api.x.ai/v1/realtime` | `grok-voice-latest` | `apiKeyEnv` (e.g. XAI_API_KEY) |
| `openai` | `wss://api.openai.com/v1/realtime` | `gpt-realtime`, `gpt-realtime-mini`, `gpt-4o-realtime-preview` | `apiKeyEnv` (default OPENAI_API_KEY) |

Example account for OpenAI realtime (routes `martin/openai/gpt-realtime`):

```json
{ "name": "martin", "provider": "openai", "providerSlug": "openai", "enabled": true, "apiKeyEnv": "OPENAI_API_KEY" }
```

`openai` (platform API key) is distinct from `openai-subscription`
(ChatGPT/Codex OAuth); it also forwards `/chat/completions` and `/responses`,
and being an api-key provider it is grantable to non-owner clients. Note:
`openai` accounts don't appear in the `/v1/models` catalog (no model-meta
integration) — use full ids.

## Usage / billing

Best-effort: the tunnel sniffs upstream `response.done` events and accumulates
`response.usage.{input,output,total}_tokens` per session, recorded into the
usage ledger on close (`path: "/v1/realtime"`, `status: 101`) plus a
`realtime session closed` log line with frame/byte counters both directions.
If the upstream omits usage events the session is still recorded, just without
token counts — no local estimate is attempted for audio.

## Verification status (2026-07-20): LIVE-VERIFIED against real xAI

Credits were refilled and the full stack was verified against the real
upstream via `scripts/verify-realtime-live.ts` (throwaway proxy, temp config,
real `XAI_API_KEY`; spends ~a cent):

- **WS tunnel, full speech-to-speech round trip**: spoke a `say`-synthesized
  sample through `ws://…/v1/realtime?model=live/grok/grok-voice-latest`;
  upstream transcribed the input ("Hello there, please tell me one fun fact."),
  streamed 273 KB of `response.output_audio.delta` plus the output transcript
  ("The world's largest snowflake was recorded in 1887 and measured 15 inches
  wide!"), full GA event ladder through `response.done`, clean close.
  Session shape mirrored the companion client: `session.update` with
  `turn_detection: null`, `audio.input.format {audio/pcm, rate 24000}`,
  `audio.input.transcription {model: grok-transcribe}`, then
  `input_audio_buffer.append` (base64 PCM) → `commit` → `response.create`.
- **Batch `/v1/audio/transcriptions`**: HTTP 200 with the exact transcript +
  word timings through the proxy.
- **Mint `/v1/realtime/client_secrets`**: HTTP 200 with a 107-char
  `xai-realtime-client-secret-…` (was 403 credits-exhausted before refill).

Caveat: xAI's realtime `response.done` reports `usage` with all-zero token
counts — the ledger records the session (frames/bytes/duration) but token
usage stays 0 until xAI populates it.

**OpenAI provider (same run):** the tunnel routed
`live-oa/openai/gpt-realtime` to the real OpenAI upstream — WS opened, key
accepted (mint returns 200 with an `ek_…` secret), and OpenAI's
`insufficient_quota` error event + 1013 close relayed verbatim to the client.
The identical error reproduces connecting to OpenAI directly (proxy bypassed),
so the block is the OpenAI **account's billing**, not the tunnel; a funded
account is the only missing piece for an OpenAI speech round trip.

Earlier mock coverage remains in `lib/realtime.test.ts` (auth rejection, model
routing incl. openai-account routing, both-way text+binary piping, pre-open
queueing, close propagation, usage capture, batch STT translation).

## genesis-server note

The ephemeral mint lives here (ai-proxy) so the account key stays in one
place; if genesis-server has (or grows) a `/api/realtime/token` route it
should proxy to `POST /v1/realtime/client_secrets` on ai-proxy rather than
hold XAI_API_KEY itself.
