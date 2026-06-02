# 04 — Transport & Trust Research (Expo SDK 55 / RN 0.83 / New Arch mandatory)

**TL;DR**
- **SSE is solved by `expo/fetch`, not by an EventSource polyfill.** RN 0.83 core `fetch` still has no `response.body` ReadableStream (facebook/react-native#27741 is open as of Feb 2026). The fix that ships *today* on the New Architecture is Expo's WinterCG-compliant `expo/fetch`, which exposes `response.body.getReader()` and is already used in production for SSE (ChatterUI, cherry-studio-app). `react-native-sse` (XHR polyfill) still works for our `/api/qa/stream` use case but is stale (last release 2024-03) and we don't need it.
- **WebSocket: RN's global `WebSocket` works on New Arch; reliability is a *userland* concern, not a native one.** Use a thin reconnect wrapper (`partysocket`, actively maintained) + an `AppState`-driven teardown/rebuild, because iOS/Android both freeze sockets when backgrounded — no library defeats OS background limits without a foreground service. ttyd itself rides a WebSocket, so this matters for terminal parity.
- **Trust tiers are a real architectural fork, and they map onto what the dashboard already does.** The existing front-proxy already runs **Cloudflare Tunnel** (`mac.foltyn.dev` + Cloudflare Access) — and CF **terminates TLS at its edge**, so the CF account owner can see plaintext. For a commercial "we can't see your data" claim, that means: **trust-max tier = Tailscale/WireGuard self-host** (relay sees only ciphertext; provably-not-in-path), and **managed-convenience tier = vendor tunnel + an app-level E2E layer above the transport** (or the claim is dishonest). Tailscale has **no embeddable mobile SDK** — the user runs the Tailscale app; our app just talks to a tailnet hostname.

---

## Part 1 — SSE on RN / Expo SDK 55

### The core problem (verified)
RN's `fetch` is a polyfill over `XMLHttpRequest`; `response.body` is `undefined`, never a `ReadableStream`. This is **facebook/react-native#27741**, opened 2020-01-11, **still Open** with comments through **2026-02-12** asking whether native stream support is planned (answer: no). Confirmed corroboration in axios#6375 (2024-04): "ReadableStream is not supported and, by extension, Response.body is not implemented." So any "read SSE chunk-by-chunk via global fetch" approach fails on RN. This is independent of New vs Legacy arch — it's a JS-layer polyfill gap.

### Option A — `expo/fetch` (RECOMMENDED for `/api/qa/stream`)
- **Source / docs:** `expo` package, `expo/fetch` submodule. Docs: https://docs.expo.dev/versions/v55.0.0/sdk/expo/#expofetch-api (verified via context7 against `/websites/expo_dev_versions_v55_0_0`). Lives in the `expo/expo` monorepo (~40k stars).
- **Maintenance:** part of the Expo SDK; SDK 55 GA Feb 2026. First-party, maintained by Expo. Actively maintained — this is the canonical "fetch with streaming" path Expo points users to.
- **New Architecture support:** **Yes.** It's a native module shipped by Expo for SDK 52+; SDK 55 is New-Arch-only and `expo/fetch` ships there. (Verified: SDK 55 docs page lists it; SDK 55 cannot disable New Arch.)
- **Expo compatibility:** Built into the `expo` package. Works in **dev-client / prebuild** (our distribution model). The docs note streaming works because it's a *native* fetch, not the XHR polyfill. Available in bare RN too if you add the `expo` package.
- **Real working example (verified, not a blog):**
  - **Expo SDK 55 docs** show the exact SSE pattern: `fetch(url, { headers: { Accept: 'text/event-stream' } })` then `resp.body.getReader()` loop.
  - **ChatterUI** (https://github.com/Vali-98/ChatterUI, ~2.4k stars, shipped Expo app) — `lib/engine/SSEFetch.ts`, last touched **2025-11-16** ("fix: cancelling readers"). Real production SSE class over `expo/fetch`: `AbortController`, `reader.cancel()`, `TextDecoder`, manual `parseSSE` line-splitter. This is essentially the reference implementation we should mirror.
  - **CherryHQ/cherry-studio-app** — multiple `import { fetch } from 'expo/fetch'` provider files (web-search streaming).
  - **vercel-labs/json-render** (`packages/react-native/src/hooks.ts`) documents in a code comment: *"React Native's built-in fetch does not support `response.body` (ReadableStream). Pass a streaming-capable fetch here, e.g. `import { fetch } from 'expo/fetch'`."*
- **Risk verdict:** **Low.** First-party, New-Arch-native, shipped-app proof, exactly matches our long-lived `text/event-stream` endpoint. Caveat: it gives a raw byte stream — *you* implement SSE framing (split on `\n\n`, parse `data:` / `event:` / `id:` lines, track `Last-Event-ID` for resume). That's ~40 lines (see ChatterUI). No automatic reconnect — wrap it.

### Option B — `react-native-sse` (binaryminds) — viable fallback, not preferred
- **Repo:** https://github.com/binaryminds/react-native-sse — the most-used RN EventSource (**~366 stars**, npm `react-native-sse`).
- **Maintenance:** **latest 1.2.1 published 2024-03-05** (verified via npm registry; `modified` 2024-03-05). No release since — ~2 years stale at SDK 55 GA. Still works, but unmaintained-ish.
- **New Architecture support:** **Yes, trivially — it's pure JS over `XMLHttpRequest`.** No native code, so no Fabric/TurboModule gate to clear; the XHR it wraps is part of RN core and works on New Arch. (Evidence: README — "We use XMLHttpRequest to establish and handle an SSE connection, so you don't need an additional native Android and iOS implementation.")
- **Expo compatibility:** **Expo Go-compatible** (no native code, no config plugin). Works everywhere.
- **Real working example:** Mercure/ChatGPT examples in its README; widely cited in RN SSE tutorials. (These are README/blog, not a verified shipped-app repo — slightly weaker evidence than `expo/fetch`.)
- **Why not preferred:** It has its own full SSE client incl. auto-reconnect + `pollingInterval`, which is convenient, BUT (a) it's stale, (b) it's a *second* HTTP stack alongside `expo/fetch` (which we'll already pull in for other streaming/native fetch), and (c) header-auth is awkward (the infamous `Authorization: { toString() {...} }` hack). Its own README warns it does **not** auto-close on background and you must wire `AppState` yourself — same lifecycle work as Option A, with less control.
- **Risk verdict:** **Medium.** Works and is zero-native, but stale and redundant with `expo/fetch`. Keep as the *interface-swappable* fallback if `expo/fetch` streaming ever regresses.

### Rejected: polyfill stack (`react-native-fetch-api` + `react-native-polyfill-globals` + `web-streams-polyfill`)
Documented in #27741 as the pre-Expo workaround. `react-native-fetch-api` author (acostalima) said 2025-09 he'd consider **sunsetting it in favor of `expo/fetch`**. Fragile (multiple users report `"Value is undefined, expected a String"` from `polyfill()`). **Do not use.**

### SSE design note for our endpoint
`/api/qa/stream` (see `src/dev-dashboard/ui/src/routes/qa.tsx:404`, `new EventSource("/api/qa/stream")`, and `front-proxy.ts:25` `pathname === "/api/qa/stream"`) emits `data:`-framed JSON `QaRow` events. The web app uses the browser `EventSource`. On RN we replace that with `expo/fetch` + a small SSE parser behind a `QaStream` interface:
```
interface QaStream { connect(onRow, onStatus): void; close(): void; }
```
so a failed transport (Option A) can be swapped for Option B without touching callers.

**Resync model — match what the web app already does (verified in qa.tsx:403-443).** The web client does NOT rely on SSE `id:`/`Last-Event-ID` resume. It dedupes incoming rows by `entry.id` (a `seen` Set) and, on mount/reconnect, merges a **separate persisted REST query** (`logQuery`) filtered to rows not already `seen`. There's no evidence the server emits SSE `id:` lines, so `Last-Event-ID` would be a no-op without a server-side change. **Mirror the existing approach on mobile:** on `AppState` resume, reconnect the stream AND re-fetch the persisted log, deduping by `id` — that closes any gap from backgrounding without new server work. Only pursue `Last-Event-ID` if we deliberately add server-side event IDs.

---

## Part 2 — WebSocket reliability on RN

Why this matters here: **ttyd is a WebSocket** (`xterm.js` over WS). The mobile terminal-parity path (whether we proxy ttyd's WS natively or render xterm.js in a WebView) ultimately depends on a robust long-lived WS. RN ships a global `WebSocket` (works on New Arch — it's RN core networking, not arch-gated).

### The hard constraint: backgrounding (verified, OS-level, not library-fixable)
- iOS suspends the app (and its sockets) shortly after backgrounding; Android Doze + battery optimizers kill background socket threads. Confirmed across sources: the only *reliable* way to keep a socket alive in background on Android is a **native foreground service** (persistent notification); iOS gives you essentially nothing for arbitrary sockets (https://javascript.plainenglish.io/keep-the-stomp-socket-alive-in-background-react-native-react-native-background-actions-a5d498473821, 2025-08). 
- **Design consequence:** Do **not** fight this. Use `AppState` to **tear down** the WS/SSE on `background`/`inactive` and **rebuild + resync** on `active`. For a dev-terminal app this is fine — tmux/cmux hold the session server-side; on resume we re-attach and ttyd/xterm replays scrollback. This is the same pattern react-native-sse's README prescribes.

### Reconnect/backoff libraries

#### `partysocket` (RECOMMENDED wrapper)
- **Repo:** https://github.com/partykit/partykit (PartySocket client; **~5.6k stars** on the monorepo). Docs: https://docs.partykit.io/reference/partysocket-api
- **Maintenance:** **latest 1.1.19, npm `modified` 2026-05-11** (verified) — actively maintained, Cloudflare-adjacent (PartyKit was acquired by Cloudflare). The successor to the abandoned `reconnecting-websocket`.
- **New Arch / Expo:** Pure JS, wraps the global `WebSocket`. No native code → no arch gate, no config plugin, **Expo Go-compatible**.
- **Features (verified):** WebSocket-API-compatible drop-in, automatic reconnect with backoff, buffers messages while reconnecting, Level0+Level2 event model.
- **Real example — HONEST CAVEAT:** A gh_grep scan for `import ... from "partysocket"` (TS/TSX) returned only **web/DOM** usage (typebot.io, webstudio, git-city, PartyKit's own examples) — **no verified React-Native/Expo shipped example was found.** It's pure-JS-over-`global.WebSocket`, so RN usage (`new PartySocket({ host, room })`) is essentially certain to work, but treat the RN-fit as *inferred, not proven by a shipped repo*. If proof is required before adoption, spike it in the dev-client first.
- **Risk verdict:** **Low.** Actively maintained, zero-native, exactly the reconnect/backoff/buffer layer we want — with the caveat that no shipped RN example was located (only DOM usage verified).

#### `reconnecting-websocket` (the classic) — avoid
- **Repo:** https://github.com/pladaria/reconnecting-websocket (**~1.3k stars**). **npm latest 4.4.0, `modified` 2022-06-26** (verified) — **abandoned ~3 years.** Still functions but `partysocket` is its actively-maintained spiritual successor. **Risk: medium-high** (unmaintained). Skip.

#### `react-native-reconnecting-websocket` (React-Sextant fork) — avoid
- https://github.com/React-Sextant/react-native-reconnecting-websocket — an old RN-specific fork of the same lib; no recent activity. **Risk: high.** Skip.

#### `react-use-websocket` — viable if we want a hook
- **Repo:** https://github.com/robtaussig/react-use-websocket (**~1.9k stars**). npm `modified` 2025-02 (reasonably current). React hook with opt-in reconnect (`shouldReconnect`, `reconnectInterval`, exponential backoff). It's React-DOM-oriented but works in RN since it wraps the global `WebSocket`. Same "no verified shipped-RN example located" caveat applies (DOM-first library). **Risk: low-medium** — fine if the team prefers a hook API; otherwise `partysocket` is leaner.

### Keep-alive
App-level **ping/pong heartbeat** (send `ping` every ~20–30s, expect `pong`, treat missed pongs as dead → reconnect). ttyd has no app-level heartbeat of its own, so if we proxy its WS we add our own liveness check on the *outer* transport, not ttyd's frames. This catches half-open NAT/CG-NAT/tunnel drops that `onclose` never fires for.

---

## Part 3 — Trust + Transport Tiers (the commercial "we can't see your data" question)

This is the load-bearing section for a commercial product. The question is **who can read plaintext between the phone and the user's machine.** The answer differs sharply by transport, and the existing dashboard already sits on the *weakest* tier for that claim.

### What the existing system does today (verified from the repo)
- `src/dev-dashboard/README.md`: dashboard runs at `http://localhost:3042`, "optionally exposed at `https://<your-host>` via a **Cloudflare Tunnel**." Public surface goes through **Cloudflare Access** (email OTP).
- `src/dev-dashboard/lib/front-proxy.ts:79-104` (`isLoopbackOnlyOrigin`): the proxy distinguishes a real local browser from tunnel/LAN by the **un-strippable `cf-ray` / `cf-connecting-ip` / `cf-visitor` / `cdn-loop` headers** — i.e. it *knows* Cloudflare is in the path and terminating the connection. `manager.ts:184` notes ttyd binds loopback-only and is reverse-proxied "(HTTPS tunnel + mobile...)".
- **Implication:** every byte the phone exchanges with the terminal — keystrokes, shell output, secrets you `cat`, env vars — passes through **Cloudflare's edge in plaintext** (TLS terminates there). That's fine for a *personal* dashboard. It is **incompatible with a vendor-managed "we can't see your data" promise** if the vendor owns the CF account.

### Tier comparison

#### Tier A — LAN / mDNS (zeroconf / Bonjour)
**What it is:** phone and Mac on the same Wi-Fi; phone discovers `mac.local`-style service via mDNS and connects directly. No third party in path at all.

- **Library: `react-native-zeroconf`** (https://github.com/balthazar/react-native-zeroconf)
  - **Maintenance:** **latest 0.14.0 published 2025-12-31** (verified npm). Actively maintained — 0.14.0 adds Android 15+ **16KB page-size alignment** (Google Play requirement since 2025-11-01) and bundles Discord's RxDNSSD. ~251 stars, **147k monthly downloads** (React Native Directory).
  - **New Architecture support: Yes (verified).** React Native Directory explicitly tags it **"New Architecture"** for Android + iOS. Note: it's a *legacy native module that works via the New-Arch Interop Layer* (auto-enabled since RN 0.74) — its npm `package.json` has **no `codegenConfig`** (verified — not a pure TurboModule). The Interop Layer is officially supported, so it runs on bridgeless New Arch; just understand it's interop, not native-codegen.
  - **Expo compatibility:** **Needs dev-client/prebuild + config (NOT Expo Go).** Requires `Info.plist` `NSBonjourServices` + `NSLocalNetworkUsageDescription` (iOS 14+ local-network permission) and Android multicast/wifi-state permissions. Set these via `app.json` `infoPlist`/`android.permissions` or a small config plugin. Community guide: https://dev.to/bfforward/how-to-use-react-native-zeroconf-with-expo-2kjc
  - **Real example:** the repo's `example/` app; widely used for printer/Chromecast/MQTT-broker discovery.
  - **Risk verdict:** **Medium.** Library is fine and New-Arch-OK, but **Android mDNS is notoriously flaky** (the README dedicates a "Known Issues" section: NSD silently stops after a few scans, dies on screen-lock/Wi-Fi-reconnect/band-switch, OEM throttling). Mitigations: prefer `DNSSD` impl over `NSD`, retry logic, `AppState` rescan. **iOS works well.** Android emulator can't do multicast at all (need a real device).
  - **Alternative (pure TurboModule):** **`@dawidzawada/bonjour-zeroconf`** (React Native Directory, New-Arch tagged, updated ~4 weeks ago, "Powered by Nitro Modules", TypeScript types, 0 deps). Newer/smaller (9 stars, 461 dl/mo) — lower adoption, but a clean Nitro/TurboModule path if interop-layer reliability disappoints. **Risk: medium-high** on maturity, **low** on arch-fit.
- **Trust property:** **Best possible — no third party, ever.** Nothing leaves the LAN. **But** only works when phone is on the same network (home/office Wi-Fi). Useless for remote access. This is a *complement* to a remote tier, not a replacement.

#### Tier B — Cloudflare Tunnel (current default) — convenience, NOT zero-knowledge
- **What it is:** `cloudflared` on the Mac dials out to CF edge; phone hits `https://mac.foltyn.dev`; CF routes to the tunnel. Already wired (see above).
- **Trust property (THE critical analysis):** **Cloudflare terminates TLS at its edge.** The connection phone→edge is one TLS session; edge→`cloudflared` is another. **CF sees plaintext in between.** Verified by multiple primary sources:
  - HN top comment on the canonical CF-tunnels writeup: *"One thing that makes Cloudflare worse for home usage is it acts as a termination point for TLS, whereas Tailscale does not."* (https://news.ycombinator.com/item?id=45946865)
  - r/selfhosted: *"To be able to use Cloudflare Tunnels for free, you have to use their SSL certificates and thus allowing them to see all traffic going through the tunnel."*
  - Even with origin "Full (Strict)" mode, that only encrypts edge→origin; the **edge still decrypts** to apply WAF/Access/caching. There is no CF-tunnel mode where CF cannot see plaintext.
- **What this means for "we can't see your data":**
  - If the **user** owns the CF account and runs their own tunnel → CF (the company) can technically see it, but *the vendor* cannot. Honest-ish, but you're trusting Cloudflare-the-company.
  - If the **vendor** runs a managed CF tunnel on the user's behalf → **the vendor can read everything.** The "we can't see your data" claim is **false** at the transport layer. The ONLY way to keep it honest is an **application-layer E2E encryption above the tunnel** (see "Managed-convenience tier" below).
- **Risk verdict:** **Low risk operationally, HIGH risk for the trust claim.** Great UX (works anywhere, no client VPN), but it is *by construction* a plaintext-visible-to-CF path. Acceptable as a **managed-convenience tier ONLY with an E2E layer on top.**

#### Tier C — Tailscale / WireGuard (trust-max)
- **What it is:** phone and Mac join the same **tailnet** (WireGuard mesh). Traffic is **end-to-end WireGuard-encrypted**; Tailscale's DERP relays (used only when no direct path) see **ciphertext only** — they cannot decrypt. This is the **provably-not-in-path** tier.
- **Trust property:** **Strongest for remote access.** WireGuard keys are generated on-device; the coordination/relay servers never hold them. Even Tailscale-the-company cannot read your traffic. This is the tier that lets a vendor *honestly* say "we can't see your data" — because the vendor literally is not a TLS terminator anywhere.
- **The Expo integration reality (verified — important):**
  - **There is NO embeddable Tailscale SDK for a mobile app.** `tsnet` (embed-Tailscale-in-your-binary) is **Go-only** — confirmed by Tailscale maintainers in **tailscale/tailscale#7240** (closed 2023-02-19): *"tsnet at present only exists for Go."* The maintainer's recommendation for non-Go is to run **`tailscaled --tun=userspace-networking` + SOCKS5**, which is not viable inside a sandboxed iOS/Android app.
  - **Therefore: the user runs the Tailscale app themselves.** Our Expo app does **not** bundle Tailscale. It simply connects to the Mac's **tailnet hostname/IP** (e.g. `mac.<tailnet>.ts.net` or `100.x.y.z`) using ordinary `expo/fetch` + `WebSocket`. When the Tailscale VPN is up on the phone, those addresses resolve and route over WireGuard transparently; when it's down, they don't resolve and we show a "connect Tailscale" hint.
  - **Auth integration:** Tailscale auth (SSO/MFA, ACLs, device approval) is handled entirely by the **Tailscale app + admin console** — out of band from our app. Our app can optionally *detect* tailnet reachability (try the `100.x` address / MagicDNS name) but **cannot drive Tailscale login**. Optional polish: deep-link to the Tailscale app, or use **Tailscale Funnel** (exposes a tailnet service publicly over HTTPS) if you want a no-VPN-on-phone option — but Funnel re-introduces a TLS-terminating relay path, so it's *not* trust-max.
  - **WireGuard-direct alternative:** for a fully self-hosted "no Tailscale account" variant, a raw WireGuard tunnel works the same way (user configures WG on the phone via the official WireGuard app; our app talks to the WG peer IP). Same property (E2E, relay-free), more setup friction, no coordination server.
- **Real example:** Tailscale is the standard homelab remote-access pattern; the "talk to a tailnet hostname from any app once the VPN is up" usage is universal (Kurrent, Kubernetes, etc. docs). No app *embeds* it — every example assumes the OS-level Tailscale client.
- **Risk verdict:** **Low risk for the trust claim (it's the gold standard), medium UX friction** (user must install + log into Tailscale, approve the device). Perfect for the **trust-max / self-host tier**; too much friction to be the *only* tier for non-technical users.

### What a "managed-convenience" tier needs to keep the no-see claim honest
If we want a one-tap remote tier (vendor-operated tunnel, no Tailscale install) **and** an honest "we can't see your data" claim, the transport (CF tunnel or any vendor relay) **will** see ciphertext only **iff** we add **application-layer E2E encryption above the transport**:

- **Model:** the Mac (terminal server) and the phone establish a shared secret out of band (e.g. a pairing QR code / device-linking code the user scans once), then derive session keys (X25519 ECDH → per-message AEAD, à la libsodium/NaCl `crypto_box`, or the Noise protocol — the same framework WireGuard uses). All terminal I/O (SSE rows, WS frames, keystrokes) is encrypted **inside** the payload before it ever hits the tunnel. The vendor relay/tunnel forwards opaque ciphertext.
- **Result:** the vendor (and Cloudflare) see only ciphertext + metadata (timing, sizes, endpoints) — **the data claim is honest**, with the standard caveat that metadata is still visible (mitigate with padding if needed).
- **Key custody is the whole game:** keys MUST be generated and stored **only on the two endpoints** (phone Secure Enclave / Keystore + the Mac). The vendor must **never** hold or escrow them. If the pairing flow routes the secret through the vendor, the claim collapses.
- **This is meaningful extra engineering** (pairing UX, key storage, ratcheting, rotation, multi-device). It's the price of "managed convenience + honest no-see." Tailscale gives you the same property *for free* by being WireGuard — which is exactly why the trust-max tier should lean on Tailscale rather than re-implement Noise.

---

## Recommendation

**Adopt a two-tier (optionally three-tier) trust model, all behind one swappable `Transport` interface.**

1. **`Transport` interface (design constraint satisfied).** Define one interface the whole app codes against:
   ```
   interface Transport {
     baseUrl(): string;                       // resolves per-tier (LAN ip / tailnet host / vendor url)
     streamQa(onRow, onStatus): Disposable;    // expo/fetch SSE under the hood
     openTerminal(sessionId): WsLike;          // partysocket-wrapped WS to ttyd
     reachable(): Promise<boolean>;            // tier-specific liveness probe
   }
   ```
   Tier selection (LAN / Tailscale / managed) just swaps which `Transport` impl is constructed. A failed SSE or WS approach is replaced without touching feature code.

2. **SSE: ship `expo/fetch` + a ~40-line SSE parser** (mirror ChatterUI's `SSEFetch.ts`), with `Last-Event-ID` resume and `AppState` teardown/rebuild. Keep `react-native-sse` documented as the drop-in fallback behind the same interface.

3. **WebSocket (ttyd terminal): global `WebSocket` wrapped in `partysocket`** for reconnect/backoff/buffering, plus an app-level ping/pong heartbeat and `AppState`-driven reconnect-and-resync. Accept that backgrounding kills the socket — rely on server-side tmux/cmux to hold the session and replay on resume.

4. **Trust tiers:**
   - **Trust-max (recommended default for the commercial "we can't see your data" promise): Tailscale (or raw WireGuard) self-host.** The user runs the Tailscale app; our app talks to the tailnet hostname. We integrate by *detecting reachability and deep-linking to Tailscale*, **not** by embedding it (no SDK exists — verified #7240). This is the only tier where the no-see claim is true by construction.
   - **LAN/mDNS (zero-third-party complement):** `react-native-zeroconf` (New-Arch via Interop Layer, verified; needs dev-client + local-network permissions). Use for same-Wi-Fi auto-discovery; expect Android flakiness, prefer the `DNSSD` impl, consider `@dawidzawada/bonjour-zeroconf` (Nitro/TurboModule) if interop reliability bites.
   - **Managed-convenience (optional, ONLY with E2E on top):** the existing Cloudflare Tunnel is fine *operationally* but **CF terminates TLS and sees plaintext** (verified). To offer a one-tap remote tier without lying, layer **endpoint-to-endpoint encryption (Noise/NaCl, keys only on phone+Mac, vendor never escrows)** above the tunnel. Without that E2E layer, a vendor-managed CF tunnel is **incompatible** with "we can't see your data."

**Confidence: high** on SSE (`expo/fetch`), the CF-TLS-termination fact, and the no-Tailscale-SDK fact (all primary-source verified). **Medium** on Android zeroconf reliability specifics (well-documented but device-dependent) and on `partysocket` being the single best WS wrapper (it's the best-maintained, but `react-use-websocket` is a fine hook-shaped alternative).
