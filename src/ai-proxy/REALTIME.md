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

## Provider support

Realtime is a provider capability (`realtimeConnect` / `realtimeClientSecrets`
on `ProxyProvider`); currently only `xai-api-key` implements it. The upstream
WS base defaults to the account's `baseUrl` with `http(s)` swapped for
`ws(s)`; set `realtimeBaseUrl` on the account to override (this is how tests
point it at a mock server).

## Usage / billing

Best-effort: the tunnel sniffs upstream `response.done` events and accumulates
`response.usage.{input,output,total}_tokens` per session, recorded into the
usage ledger on close (`path: "/v1/realtime"`, `status: 101`) plus a
`realtime session closed` log line with frame/byte counters both directions.
If the upstream omits usage events the session is still recorded, just without
token counts — no local estimate is attempted for audio.

## Verification status (2026-07-20)

**Live xAI verification is pending credits** — the team's xAI credits are
exhausted (`POST /v1/realtime/client_secrets` → 403 "team … used all available
credits"). The tunnel is verified against a mock upstream WS instead
(`lib/realtime.test.ts`): auth rejection, model routing (upstream saw
`grok-voice-latest` + the account key), text and binary frames piped both ways,
pre-upstream-open frames queued not dropped, upstream close propagated with
code/reason, and usage capture from `response.done`. Once credits exist, a live
check is just: connect the URL above with a real key and speak.

## genesis-server note

The ephemeral mint lives here (ai-proxy) so the account key stays in one
place; if genesis-server has (or grows) a `/api/realtime/token` route it
should proxy to `POST /v1/realtime/client_secrets` on ai-proxy rather than
hold XAI_API_KEY itself.
