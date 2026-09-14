# 02 — Transport & Trust Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`. Read
> `…-00-Overview.md` and `…-ADR.md` first. Work in the `feat/dev-dashboard-mobile` worktree.
> **Depends on 01 (ServerExtraction)** for `serveAgent`, the route registry, and `lib/auth.ts`,
> and on **03 (SharedContract)** for `createDashboardClient` + the injected `eventSourceFactory`.
> Before any stack-specific step, search current docs (ADR §0): `context7`
> `/websites/expo_dev_versions_v55_0_0`, the `expo:*` skills, and web search — versions move.
> **Install native modules with `npx expo install <pkg>`, never `bun add`** (ADR §6 install rule);
> only pure-JS libs (`partysocket`, `tweetnacl`) may use `bun add`.

**Goal:** Implement the ADR §4 `Transport` interface and **all four trust tiers** behind it —
(1) LAN/mDNS, (2) Tailscale reachability + deep-link, (3) self-hosted cloudflared via a near-zero-
friction Agent CLI wizard, (4) vendor-managed with an **app-layer E2E encryption** layer — plus the
RN SSE (`QaStream` via `expo/fetch`) and WebSocket (`TerminalTransport` via `partysocket`) clients,
and the mobile Connect/Pair UX (tier picker, QR scan, reachability states) with an Appium spec.

**Architecture:** The whole mobile app codes against one `Transport` interface (`baseUrl()`,
`authHeader()`, `reachable()`, `streamQa()`, `openTerminal()`). Tier selection swaps the concrete
impl. Three tiers (LAN, Tailscale, self-cloudflared) are *plaintext-honest by topology* and share a
`PlainTransport` base that wires `createDashboardClient` (03) to `expo/fetch` + a `~40-line SSE
parser` (`QaStream`) and a `partysocket`-wrapped WS (`TerminalTransport`). The managed tier wraps
that same base in an `E2eTransport` decorator that encrypts every payload with per-message AEAD
(X25519 ECDH established at QR/device-code pairing; keys only in `expo-secure-store` on the phone +
a key file on the Mac). The Agent side gains: an `_devdashboard._tcp` mDNS advertiser, a
`tools dev-dashboard tunnel setup` cloudflared wizard that emits a pairing QR, and (managed only) an
E2E unwrap/rewrap shim in front of the route registry.

**Tech Stack:** Agent — Bun + TypeScript, `bun:test`, the 01 route registry, `cloudflared` (shelled),
Bonjour via `dns-sd`/`bun:ffi`-free shell or a tiny mDNS responder. Mobile — Expo SDK 55 / RN 0.83,
`expo/fetch` (SSE), `partysocket` (WS), `react-native-zeroconf` (LAN), `expo-camera` `CameraView`
(QR scan), `expo-linking` (Tailscale deep-link), `expo-secure-store` (keys), `tweetnacl` **OR**
`react-native-libsodium` for the E2E crypto (**PROPOSED below — confirm with user**). Tests: RN test
runner for pure logic (SSE parser, envelope codec, reachability reducer), `bun:test` for the Agent.

**Definition of done:** the `Transport` interface + the SSE parser + the WS wrapper have green unit
tests; all four tier impls construct and pass their `reachable()` contract test; the Agent advertises
`_devdashboard._tcp`, the `tunnel setup` wizard emits a scannable pairing QR, and the managed E2E
round-trips a `crypto_box` envelope in both directions (Agent unit + mobile unit); the mobile
Connect/Pair screen renders the tier picker + QR scanner + per-tier reachability state; and the
**ConnectPage Appium spec passes** on the iOS dev-client (tier switch + reachable/unreachable states).

---

## PROPOSED library decision (confirm with user before Task 8)

The E2E tier needs an X25519 ECDH + AEAD primitive that runs on RN 0.83 New Architecture. Three
candidates were researched (gh_grep + web, 2026-05-29):

- **`tweetnacl` (+ `tweetnacl-util`)** — pure JS, zero native code, New-Arch-trivial (no Fabric gate),
  Expo-Go-compatible, ~9 KB. `nacl.box(msg, nonce, theirPub, mySecret)` = X25519+XSalsa20-Poly1305 —
  exactly our `crypto_box`. **Risk: low-medium** — pure-JS Curve25519 on Hermes is ~ms-per-op (fine
  for terminal frames? benchmark in Task 8 Step 0). Expo fork `rajtatata/react-native-expo-tweet-nacl`
  exists if the base pkg's PRNG needs `expo-crypto` seeding.
- **`react-native-libsodium`** — native libsodium binding; full `crypto_box_easy`/`crypto_secretstream`
  API; **verified in production** (`lunel-dev/lunel` ships a CLI-agent + RN-app transport doing exactly
  our ECDH session bootstrap with `crypto_box_easy`; `slopus/happy` uses it too). Fast (native). **Risk:
  medium** — native module → must pass the New-Arch gate (verify the installed version is Fabric/TurboModule
  or interop-OK on SDK 55), needs dev-client/prebuild (already our model).
- **`expo-crypto`** — **rejected for this**: it's hashing/random/digest only (no public-key box). Use it
  only to seed `tweetnacl`'s PRNG if needed.

**Recommendation: start with `tweetnacl` + `tweetnacl-util`** (zero native, ships in Expo Go, no
arch-gate risk, the crypto is identical NaCl `crypto_box`), and keep `react-native-libsodium` as the
documented swap-in behind the same `BoxCipher` interface (Task 8) if the Task-8-Step-0 Hermes
benchmark shows pure-JS box is too slow for live terminal throughput. **Surface both options +
this recommendation to the user (ADR §0 rule 2) before installing.** The `BoxCipher` interface makes
the choice reversible.

---

## Managed-(sub)domain cloudflared — optional sub-variant (DECISIONS D10)

For users who run their **own** `cloudflared` but **lack a domain**, the `tools dev-dashboard tunnel
setup` wizard offers a **managed (sub)domain** so they still get a clean, stable URL without buying
one. Strictly opt-in; the default stays bring-your-own-domain / Tailscale.

- **Wizard branch:** asks "Use your own domain" vs "Get a managed subdomain
  (`<name>.devdashboard.app`)". The managed branch calls a new
  `requestManagedSubdomain(cloudApiToken, desiredName)` helper in `lib/tunnel/cloudflared.ts` (talks
  to the DevDashboard Cloud API — plan 10) to reserve the name + get routing config.
- **Impl options (plan 10 decides):** Cloudflare for SaaS / custom hostnames routing a vendor-owned
  subdomain to the user's tunnel, or a vendor wildcard zone.
- **TRUST CAVEAT (shown in the wizard):** if the **vendor's** CF account fronts the subdomain, the
  vendor edge terminates TLS → this variant **inherits the managed-tier E2E requirement**
  (`BoxCipher`/`E2eEnvelope`, Task 8). A DNS-delegated-to-the-user's-own-CF variant keeps tier-3 trust.
  The wizard prints which property the chosen option provides.
- **Tasks:** add `requestManagedSubdomain` + test; add the wizard branch in `commands/tunnel.ts`;
  vendor-fronted managed-subdomains use `createManagedTransport` (E2E) on the mobile side.

## File Structure

### Agent side (`src/dev-dashboard/`)

**Create:**
- `src/dev-dashboard/server/transport/mdns-advertiser.ts` — advertises `_devdashboard._tcp` over Bonjour; one responsibility: publish/unpublish the service.
- `src/dev-dashboard/server/transport/mdns-advertiser.test.ts`
- `src/dev-dashboard/lib/tunnel/cloudflared.ts` — pure cloudflared CLI helpers (`detectCloudflared`, `loginUrl`, `createTunnel`, `routeDns`, `writeConfig`, `runTunnel`) — no prompts here.
- `src/dev-dashboard/lib/tunnel/cloudflared.test.ts`
- `src/dev-dashboard/lib/tunnel/pairing.ts` — builds + parses the pairing payload (URL + QR), persists tunnel config to `~/.genesis-tools/dev-dashboard/tunnel.json`.
- `src/dev-dashboard/lib/tunnel/pairing.test.ts`
- `src/dev-dashboard/commands/tunnel.ts` — the `tools dev-dashboard tunnel setup` wizard (clack prompts → calls `lib/tunnel/*`).
- `src/dev-dashboard/lib/e2e/box.ts` — Agent-side `BoxCipher` (X25519 keypair on disk + `crypto_box` seal/open) reused by the relay shim.
- `src/dev-dashboard/lib/e2e/box.test.ts`
- `src/dev-dashboard/lib/e2e/envelope.ts` — the wire envelope codec (`E2eEnvelope` encode/decode) shared with mobile via copy-kept-in-sync test vectors.
- `src/dev-dashboard/lib/e2e/envelope.test.ts`
- `src/dev-dashboard/server/transport/e2e-shim.ts` — Agent request decorator: decrypt inbound managed-tier `E2eEnvelope`, run the route registry, re-encrypt the result.
- `src/dev-dashboard/server/transport/e2e-shim.test.ts`

**Modify:**
- `src/dev-dashboard/index.ts` — register the `tunnel` subcommand.
- `src/dev-dashboard/server/serve.ts` — accept `{ advertiseMdns?, e2e? }`; start the advertiser + (managed) mount the E2E shim ahead of the router.

### Mobile side (`DevDashboard/mobile/`)

**Create:**
- `DevDashboard/mobile/src/transport/Transport.ts` — the `Transport`, `QaStream`, `TerminalTransport`, `Disposable`, `TransportTier` interfaces (the contract the whole app codes against).
- `DevDashboard/mobile/src/transport/sse-parser.ts` — the ~40-line `parseSseChunks` + `streamSse(url, …)` over `expo/fetch`.
- `DevDashboard/mobile/src/transport/sse-parser.test.ts`
- `DevDashboard/mobile/src/transport/qa-stream.ts` — `createQaStream(...)` implementing `QaStream` over `streamSse` (fallback `react-native-sse` documented).
- `DevDashboard/mobile/src/transport/qa-stream.test.ts`
- `DevDashboard/mobile/src/transport/terminal-ws.ts` — `createTerminalTransport(...)` implementing `TerminalTransport` over `partysocket` (+ heartbeat + AppState).
- `DevDashboard/mobile/src/transport/terminal-ws.test.ts`
- `DevDashboard/mobile/src/transport/plain-transport.ts` — `PlainTransport` base (LAN/Tailscale/self-cloudflared share it); wires `createDashboardClient` (03) + the SSE + WS clients.
- `DevDashboard/mobile/src/transport/plain-transport.test.ts`
- `DevDashboard/mobile/src/transport/tiers/lan.ts` — `createLanTransport` (zeroconf discovery → `PlainTransport`).
- `DevDashboard/mobile/src/transport/tiers/tailscale.ts` — `createTailscaleTransport` (reachability probe + `openTailscaleApp` deep-link → `PlainTransport`).
- `DevDashboard/mobile/src/transport/tiers/cloudflared.ts` — `createCloudflaredTransport` (scanned pairing URL → `PlainTransport`).
- `DevDashboard/mobile/src/transport/tiers/managed.ts` — `createManagedTransport` (`E2eTransport` decorator over a relay `PlainTransport`).
- `DevDashboard/mobile/src/transport/tiers/managed.test.ts`
- `DevDashboard/mobile/src/transport/e2e/box-cipher.ts` — mobile `BoxCipher` (the PROPOSED lib behind the interface) + `loadOrCreateDeviceKeys` (SecureStore).
- `DevDashboard/mobile/src/transport/e2e/box-cipher.test.ts`
- `DevDashboard/mobile/src/transport/e2e/envelope.ts` — mirror of the Agent envelope codec (shares the Agent test vectors).
- `DevDashboard/mobile/src/transport/e2e/envelope.test.ts`
- `DevDashboard/mobile/src/transport/e2e-transport.ts` — `E2eTransport` decorator (encrypts client calls + SSE + WS frames; vendor relay sees ciphertext).
- `DevDashboard/mobile/src/transport/lan-discovery.ts` — `useZeroconfDiscovery()` hook + `DiscoveredAgent` type.
- `DevDashboard/mobile/src/transport/reachability.ts` — pure `reachabilityReducer` + `ReachState` (probing/reachable/unreachable/needs-vpn/needs-pair).
- `DevDashboard/mobile/src/transport/reachability.test.ts`
- `DevDashboard/mobile/src/state/connection-store.ts` — Zustand store: active tier, persisted endpoints, creds, pairing keys (ADR §6 — `expo-sqlite/kv-store` for prefs, `expo-secure-store` for secrets).
- `DevDashboard/mobile/src/lib/qr.ts` — `parsePairingPayload(scanned: string)` + `buildDeviceCode()` (shared shapes with `lib/tunnel/pairing.ts`).
- `DevDashboard/mobile/src/lib/qr.test.ts`
- `DevDashboard/mobile/app/connect.tsx` — the Connect/Pair screen (tier picker + QR scanner + reachability UI). a11y-id'd for Appium.
- `DevDashboard/mobile/src/components/connect/TierPicker.tsx`
- `DevDashboard/mobile/src/components/connect/QrScanner.tsx`
- `DevDashboard/mobile/src/components/connect/ReachabilityBadge.tsx`
- `DevDashboard/mobile/e2e/pages/ConnectPage.page.ts` — Page Object (accessibility-id locators).
- `DevDashboard/mobile/e2e/specs/connect.spec.ts` — the ConnectPage Appium spec.

**Modify:**
- `DevDashboard/mobile/app.config.ts` — config plugin block: iOS `NSBonjourServices` + `NSLocalNetworkUsageDescription` + `NSCameraUsageDescription`; Android `INTERNET`/`ACCESS_NETWORK_STATE`/`CHANGE_WIFI_MULTICAST_STATE`/`ACCESS_WIFI_STATE`/`CAMERA`; `react-native-zeroconf` + `expo-camera` plugin entries.

> **Boundary note:** `DevDashboard/mobile/` is bootstrapped in **plan 04**. If 02 runs before 04's
> scaffold exists, do the **Agent-side tasks (0, 1-4 server-side, 6a, 8, 9-10 Agent halves)** first;
> the mobile-side tasks assume 04's Expo project, `app/` router, and `app.config.ts` exist. The ADR
> phasing is 01 → 03 → 02 → 04, so in practice 02's mobile tasks land *after* 04 — keep the file paths
> above as the target.

---

### Task 0: Relocate the RN-safe shared helpers into `@devdashboard/contract` (bundle-safety gate)

> **Why first:** the mobile transport tiers need `makeBasicAuthHeader`, the pairing-URI codec, the
> `E2eEnvelope` codec, and the `BoxCipher`/`KeyPair` types. Those currently live (or would live) in
> `lib/auth.ts` / `lib/tunnel/pairing.ts` / `lib/e2e/*` — all of which value-import `node:crypto` /
> `node:os` / `bun`. Importing ANY of them into the Hermes bundle drags server-only runtime in and
> the app won't build (the exact contract plan 03's `contract-purity.test.ts` enforces). So the
> **pure** parts move into the contract package; `lib/*` re-exports them for the Agent. This is the
> single seam that lets every mobile import go through the `@app/dev-dashboard/contract` door.

**Files (extend plan 03's `src/dev-dashboard/contract/`):**
- Create: `src/dev-dashboard/contract/auth-header.ts` — pure `makeBasicAuthHeader({username,password})` + `parseBasicAuthHeader` (NO `node:crypto`; just base64 string work).
- Create: `src/dev-dashboard/contract/pairing.ts` — `PairingPayload`, `PairingTier`, `buildPairingPayload`, `parsePairingPayload` (pure `URLSearchParams` only — moved out of `lib/tunnel/pairing.ts`).
- Create: `src/dev-dashboard/contract/e2e-envelope.ts` — `E2eEnvelope`, `encodeEnvelope`, `decodeEnvelope`.
- Create: `src/dev-dashboard/contract/box-types.ts` — the `BoxCipher` + `KeyPair` interfaces (types only; the `nacl` IMPL stays per-platform in `lib/e2e/box.ts` and mobile `box-cipher.ts`).
- Modify: `src/dev-dashboard/contract/index.ts` — re-export the four new modules.
- Modify: `src/dev-dashboard/contract/contract-purity.test.ts` — add the four files to the purity `FILES` list.
- Modify: `src/dev-dashboard/lib/auth.ts`, `src/dev-dashboard/lib/tunnel/pairing.ts`, `src/dev-dashboard/lib/e2e/{envelope,box}.ts` — re-export the moved symbols so the Agent keeps its existing import paths (`front-proxy.ts` / `auth-guard.ts` untouched).

- [ ] **Step 1: Move `makeBasicAuthHeader` + `parseBasicAuthHeader` into `contract/auth-header.ts`**

These two functions in `lib/auth.ts` only do base64 string work — they do NOT need `node:crypto`
(only `hashPassword`/`verify*`/`scryptSync` do). Extract the pure pair:

```typescript
export interface BasicAuthInput {
    username: string;
    password: string;
}

/** Pure base64 — no node:crypto. Safe for the RN bundle. */
export function makeBasicAuthHeader(input: BasicAuthInput): string {
    const raw = `${input.username}:${input.password}`;
    // btoa exists in Hermes (RN) and Bun; encode UTF-8 first for non-ASCII passwords.
    const b64 = typeof btoa === "function" ? btoa(unescape(encodeURIComponent(raw))) : Buffer.from(raw, "utf8").toString("base64");
    return `Basic ${b64}`;
}

export function parseBasicAuthHeader(header: string | null): BasicAuthInput | null {
    if (!header || !/^basic\s+/i.test(header)) {
        return null;
    }

    const encoded = header.replace(/^basic\s+/i, "").trim();
    const decoded = typeof atob === "function" ? decodeURIComponent(escape(atob(encoded))) : Buffer.from(encoded, "base64").toString("utf8");
    const i = decoded.indexOf(":");

    if (i < 1) {
        return null;
    }

    return { username: decoded.slice(0, i), password: decoded.slice(i + 1) };
}
```

Then in `lib/auth.ts` delete the local copies and add
`export { makeBasicAuthHeader, parseBasicAuthHeader } from "@app/dev-dashboard/contract/auth-header";`
(the crypto verifiers `verifyBasicAuthHeader` etc. stay in `lib/auth.ts` and call the moved parser).

- [ ] **Step 2: Write the pairing codec in `contract/pairing.ts` (full code — this is the SOURCE OF TRUTH)**

> This is where the pairing codec is *defined* (it uses only `URLSearchParams` — pure). Task 8's
> `lib/tunnel/pairing.ts` re-exports from here and adds only the disk-touching persist/load helpers.

```typescript
export type PairingTier = "cloudflared-self" | "managed";

export interface PairingPayload {
    tier: PairingTier;
    baseUrl: string;
    username: string;
    /** Managed tier only: the Agent's X25519 public key (base64) for E2E pairing (Task 9/10). */
    agentPublicKey?: string;
}

const SCHEME = "devdashboard://pair?";

/** Encodes the pairing payload as a `devdashboard://pair?…` URI (QR-friendly, compact). */
export function buildPairingPayload(payload: PairingPayload): string {
    const sp = new URLSearchParams();
    sp.set("tier", payload.tier);
    sp.set("baseUrl", payload.baseUrl);
    sp.set("username", payload.username);

    if (payload.agentPublicKey) {
        sp.set("pk", payload.agentPublicKey);
    }

    return `${SCHEME}${sp.toString()}`;
}

export function parsePairingPayload(uri: string): PairingPayload | null {
    if (!uri.startsWith(SCHEME)) {
        return null;
    }

    const sp = new URLSearchParams(uri.slice(SCHEME.length));
    const tier = sp.get("tier");
    const baseUrl = sp.get("baseUrl");
    const username = sp.get("username");

    if ((tier !== "cloudflared-self" && tier !== "managed") || !baseUrl || !username) {
        return null;
    }

    const payload: PairingPayload = { tier, baseUrl, username };
    const pk = sp.get("pk");

    if (pk) {
        payload.agentPublicKey = pk;
    }

    return payload;
}
```

- [ ] **Step 3: Write the envelope codec + box types in the contract (full code — SOURCE OF TRUTH)**

`contract/e2e-envelope.ts` (uses `SafeJSON`, which is RN-bundle-safe — its only dep is `comment-json`,
pure JS, verified no `node:`/`bun:` imports; so the contract leaf stays clean AND obeys the repo's
"always SafeJSON, never JSON" rule):

```typescript
import { SafeJSON } from "@app/utils/json";

/** The wire envelope the vendor relay forwards opaquely. epk/n/ct are the only fields. */
export interface E2eEnvelope {
    v: 1;
    /** sender public key, base64 */
    epk: string;
    /** nonce, base64 */
    n: string;
    /** ciphertext (crypto_box output), base64 */
    ct: string;
}

export function encodeEnvelope(env: E2eEnvelope): string {
    return SafeJSON.stringify(env);
}

export function decodeEnvelope(raw: string): E2eEnvelope {
    const env = SafeJSON.parse(raw, { strict: true }) as E2eEnvelope;

    if (env.v !== 1 || typeof env.epk !== "string" || typeof env.n !== "string" || typeof env.ct !== "string") {
        throw new Error("invalid E2eEnvelope");
    }

    return env;
}
```

> NOTE: `SafeJSON` is confirmed RN-bundle-safe (sole dependency `comment-json` is pure JS — no
> `node:`/`bun:`). The same applies to mobile `qa-stream.ts` (Task 3), which uses `SafeJSON` too — one
> consistent JSON layer across Agent + contract + mobile, no bare `JSON`. The purity guard
> (`contract-purity.test.ts`) checks for `node:`/`bun:` imports; `@app/utils/json` is allowed because
> it pulls neither.

`contract/box-types.ts` (types only — the `nacl` impl stays per-platform in `lib/e2e/box.ts` + mobile
`box-cipher.ts`):

```typescript
export interface KeyPair {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
}

/** The swap seam: tweetnacl now, react-native-libsodium later — same API. */
export interface BoxCipher {
    seal(args: { plaintext: Uint8Array; nonce: Uint8Array; recipientPublicKey: Uint8Array; senderSecretKey: Uint8Array }): Uint8Array;
    open(args: { ciphertext: Uint8Array; nonce: Uint8Array; senderPublicKey: Uint8Array; recipientSecretKey: Uint8Array }): Uint8Array | null;
    randomNonce(): Uint8Array;
    keyPair(): KeyPair;
}
```

- [ ] **Step 4: Extend the purity guard + run it**

Add the four files to `contract-purity.test.ts`'s `FILES` list (plan 03 Task 2) so they're proven free
of `node:`/`bun:`/`lib/*` value imports.

Run: `bun test src/dev-dashboard/contract/contract-purity.test.ts ; bun test src/dev-dashboard/`
Expected: PASS — the new files are pure; the Agent's existing auth/pairing/e2e tests still pass via the
re-exports (no behavior change).

- [ ] **Step 5: Commit**

```bash
git add src/dev-dashboard/contract/ src/dev-dashboard/lib/auth.ts src/dev-dashboard/lib/tunnel/pairing.ts src/dev-dashboard/lib/e2e/
git commit -m "refactor(dd-contract): relocate pure auth-header/pairing/envelope/box-types into the RN-safe contract"
```

> After Task 0, **every mobile file imports these from `@app/dev-dashboard/contract`** (the cross-Expo
> import mechanism — path alias vs local workspace pkg — is the ADR §3 / plan 04 decision; see
> openQuestions). The Agent keeps working through the re-exports. Tasks 8/9 below author the *impl*
> halves (`lib/tunnel/cloudflared.ts`, `lib/e2e/box.ts`'s `nacl` impl + disk keys) which legitimately
> stay in `lib/*` because they shell out / touch disk.

---

### Task 1: The `Transport` interface (the contract the whole app codes against)

> This is the load-bearing type from ADR §4. Every feature plan (05-09) consumes `Transport`;
> tier selection swaps the impl. Define it once, here. No logic — types only.
>
> **ADR reconciliation (read before coding so plan 07 doesn't collide):** ADR §4 sketches
> `streamQa(onRow, onStatus): Disposable`. We realize that as **`streamQa(): QaStream`** whose
> `.connect(onRow, onStatus)` carries the exact `(onRow, onStatus)` callbacks — the richer
> `QaStream` shape comes from research file 04 (it needs an explicit `close()` for AppState teardown
> and a status channel, which a bare `Disposable` can't express). The `client()` member is added
> beyond the ADR sketch so feature plans get a ready-wired `@devdashboard/contract` client per tier.
> These are deliberate, documented refinements — NOT silent divergence. `Disposable` is kept as the
> return type of any future fire-and-forget subscription; if nothing uses it after Task 11, delete
> it rather than leave a dead type.

**Files:**
- Create: `DevDashboard/mobile/src/transport/Transport.ts`

- [ ] **Step 1: Write `Transport.ts` (full code)**

```typescript
import type { DashboardClient } from "@app/dev-dashboard/contract";
import type { QaEntry } from "@app/dev-dashboard/contract";

export type TransportTier = "lan" | "tailscale" | "cloudflared-self" | "managed";

/** A cancellable subscription (ADR §4 `streamQa` return). */
export interface Disposable {
    dispose(): void;
}

/** SSE Q&A stream (ADR §4). The contract's `eventSourceFactory` plugs this in. */
export interface QaStream {
    /** Begin streaming. `onRow` for each enriched entry; `onStatus` for connection state. */
    connect(onRow: (entry: QaEntry) => void, onStatus: (status: QaStreamStatus) => void): void;
    /** Tear down (AppState background, screen unmount). */
    close(): void;
}

export type QaStreamStatus = "connecting" | "open" | "closed" | "error";

/** ttyd WebSocket transport (ADR §4 `openTerminal`). xterm/WebView driver (plan 06) drives this. */
export interface TerminalTransport {
    /** Send raw bytes (keystrokes) to ttyd. */
    send(data: string | ArrayBufferLike): void;
    /** ttyd output frames. */
    onMessage(handler: (data: string | ArrayBuffer) => void): void;
    /** Connection lifecycle for the renderer's status pill. */
    onStatus(handler: (status: TerminalStatus) => void): void;
    /** Close the socket (does NOT kill the server-side tmux/cmux session). */
    close(): void;
    readonly status: TerminalStatus;
}

export type TerminalStatus = "connecting" | "open" | "reconnecting" | "closed";

/**
 * The single transport contract (ADR §4). Tier selection swaps which impl is constructed;
 * a failed SSE/WS pick is replaced without touching feature code.
 */
export interface Transport {
    readonly tier: TransportTier;
    /** LAN ip / tailnet host / tunnel url / relay url. No trailing slash. */
    baseUrl(): string;
    /** "Basic …" from SecureStore, or undefined (cookie/loopback tiers). */
    authHeader(): string | undefined;
    /** Tier-specific liveness probe (mDNS hit / tailnet GET / tunnel GET / relay handshake). */
    reachable(): Promise<boolean>;
    /** A `@devdashboard/contract` client already wired to this tier's fetch + auth + SSE factory. */
    client(): DashboardClient;
    /** SSE Q&A stream under the hood (expo/fetch on plain tiers; E2E-wrapped on managed). */
    streamQa(): QaStream;
    /** partysocket-wrapped ttyd WS (+ cookie/token; E2E-wrapped on managed). */
    openTerminal(sessionId: string): TerminalTransport;
}
```

- [ ] **Step 2: Typecheck**

Run: `cd DevDashboard/mobile && bunx tsgo --noEmit | rg "transport/Transport"`
Expected: no errors referencing `Transport.ts` (the `@devdashboard/contract` import resolves via the
local workspace package set up in 03/04).

- [ ] **Step 3: Commit**

```bash
git add DevDashboard/mobile/src/transport/Transport.ts
git commit -m "feat(dd-mobile): Transport/QaStream/TerminalTransport interfaces (ADR §4)"
```

---

### Task 2: SSE parser (`expo/fetch` + ~40-line framer)

> Mirrors ChatterUI's `SSEFetch.ts` (research file 04). RN core `fetch` has no `ReadableStream`
> (facebook/react-native#27741), so we stream with `expo/fetch` and frame `data:` lines ourselves.
> Pure-logic parser is unit-tested with the RN test runner; the `streamSse` wrapper is thin.

**Files:**
- Create: `DevDashboard/mobile/src/transport/sse-parser.ts`
- Test: `DevDashboard/mobile/src/transport/sse-parser.test.ts`

- [ ] **Step 1: Write the failing test (pure framer)**

```typescript
import { describe, expect, it } from "@jest/globals";
import { SseFramer } from "../src/transport/sse-parser";

describe("SseFramer", () => {
    it("emits one event per data: line after a blank line", () => {
        const out: string[] = [];
        const f = new SseFramer((ev) => out.push(ev.data));
        f.push("data: hello\n\n");
        expect(out).toEqual(["hello"]);
    });

    it("buffers across chunk boundaries (event split mid-stream)", () => {
        const out: string[] = [];
        const f = new SseFramer((ev) => out.push(ev.data));
        f.push("data: par");
        f.push("tial\n");
        f.push("\n");
        expect(out).toEqual(["partial"]);
    });

    it("ignores comment keep-alives (: ping)", () => {
        const out: string[] = [];
        const f = new SseFramer((ev) => out.push(ev.data));
        f.push(": ping\n\n");
        f.push("data: real\n\n");
        expect(out).toEqual(["real"]);
    });

    it("joins multi-line data: fields with newline", () => {
        const out: string[] = [];
        const f = new SseFramer((ev) => out.push(ev.data));
        f.push("data: a\ndata: b\n\n");
        expect(out).toEqual(["a\nb"]);
    });

    it("captures event: and id: fields", () => {
        const events: Array<{ event?: string; id?: string; data: string }> = [];
        const f = new SseFramer((ev) => events.push(ev));
        f.push("event: qa\nid: 7\ndata: x\n\n");
        expect(events[0]).toEqual({ event: "qa", id: "7", data: "x" });
    });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd DevDashboard/mobile && bun run test src/transport/sse-parser.test.ts` (RN test runner; see 04 for the exact script name)
Expected: FAIL — `SseFramer` is not exported / module missing.

- [ ] **Step 3: Implement `sse-parser.ts` (full code)**

```typescript
import { fetch as expoFetch } from "expo/fetch";

export interface SseEvent {
    event?: string;
    id?: string;
    data: string;
}

/** Pure SSE line framer. Feed raw decoded text via `push`; it emits complete events. */
export class SseFramer {
    private buffer = "";
    private dataLines: string[] = [];
    private eventName: string | undefined;
    private eventId: string | undefined;

    constructor(private readonly onEvent: (event: SseEvent) => void) {}

    push(chunk: string): void {
        this.buffer += chunk;
        let nl = this.buffer.indexOf("\n");

        while (nl !== -1) {
            const line = this.buffer.slice(0, nl).replace(/\r$/, "");
            this.buffer = this.buffer.slice(nl + 1);
            this.handleLine(line);
            nl = this.buffer.indexOf("\n");
        }
    }

    private handleLine(line: string): void {
        if (line === "") {
            this.dispatch();
            return;
        }

        if (line.startsWith(":")) {
            return;
        }

        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");

        if (field === "data") {
            this.dataLines.push(value);
            return;
        }

        if (field === "event") {
            this.eventName = value;
            return;
        }

        if (field === "id") {
            this.eventId = value;
        }
    }

    private dispatch(): void {
        if (this.dataLines.length === 0 && this.eventName === undefined && this.eventId === undefined) {
            return;
        }

        const event: SseEvent = { data: this.dataLines.join("\n") };

        if (this.eventName !== undefined) {
            event.event = this.eventName;
        }

        if (this.eventId !== undefined) {
            event.id = this.eventId;
        }

        this.dataLines = [];
        this.eventName = undefined;
        this.eventId = undefined;
        this.onEvent(event);
    }
}

export interface StreamSseOptions {
    url: string;
    headers?: Record<string, string>;
    onEvent: (event: SseEvent) => void;
    onOpen?: () => void;
    onError?: (err: unknown) => void;
}

/** Opens an SSE stream over expo/fetch and frames it. Returns an aborter. */
export function streamSse(opts: StreamSseOptions): { close: () => void } {
    const controller = new AbortController();

    void (async () => {
        try {
            const res = await expoFetch(opts.url, {
                method: "GET",
                headers: { Accept: "text/event-stream", ...(opts.headers ?? {}) },
                signal: controller.signal,
            });

            if (!res.ok || !res.body) {
                opts.onError?.(new Error(`sse ${opts.url} -> ${res.status}`));
                return;
            }

            opts.onOpen?.();
            const framer = new SseFramer(opts.onEvent);
            const reader = res.body.getReader();
            const decoder = new TextDecoder();

            for (;;) {
                const { value, done } = await reader.read();

                if (done) {
                    break;
                }

                framer.push(decoder.decode(value, { stream: true }));
            }
        } catch (err) {
            if (!controller.signal.aborted) {
                opts.onError?.(err);
            }
        }
    })();

    return { close: () => controller.abort() };
}
```

- [ ] **Step 4: Run to confirm it passes**

Run: `cd DevDashboard/mobile && bun run test src/transport/sse-parser.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add DevDashboard/mobile/src/transport/sse-parser.ts DevDashboard/mobile/src/transport/sse-parser.test.ts
git commit -m "feat(dd-mobile): SSE framer + expo/fetch streamSse (RN-safe streaming)"
```

---

### Task 3: `QaStream` impl + AppState resync

> Implements the `QaStream` interface (Task 1) over `streamSse` (Task 2). Resync model mirrors the
> web (research file 04, verified qa.tsx:403-443): on `AppState` resume, reconnect AND re-fetch the
> persisted `/api/qa/log`, deduping by `entry.id` — no `Last-Event-ID` (server emits no SSE ids).

**Files:**
- Create: `DevDashboard/mobile/src/transport/qa-stream.ts`
- Test: `DevDashboard/mobile/src/transport/qa-stream.test.ts`

- [ ] **Step 1: Write the failing test (inject a fake streamSse so the test is hermetic)**

```typescript
import { describe, expect, it } from "@jest/globals";
import type { SseEvent } from "../src/transport/sse-parser";
import { createQaStream } from "../src/transport/qa-stream";

function fakeStreamFactory(scripted: SseEvent[]) {
    return (opts: { onEvent: (e: SseEvent) => void; onOpen?: () => void }) => {
        opts.onOpen?.();
        for (const e of scripted) {
            opts.onEvent(e);
        }
        return { close() {} };
    };
}

describe("createQaStream", () => {
    it("parses each data: frame as a QaEntry and forwards open->open status", () => {
        const rows: string[] = [];
        const statuses: string[] = [];
        const stream = createQaStream({
            baseUrl: "http://h",
            authHeader: () => "Basic z",
            streamSseImpl: fakeStreamFactory([{ data: JSON.stringify({ id: "1", question: "q", answer: "a" }) }]),
        });
        stream.connect(
            (entry) => rows.push(entry.id),
            (s) => statuses.push(s),
        );
        expect(rows).toEqual(["1"]);
        expect(statuses).toContain("open");
    });

    it("dedupes a re-delivered id", () => {
        const rows: string[] = [];
        const stream = createQaStream({
            baseUrl: "http://h",
            authHeader: () => undefined,
            streamSseImpl: fakeStreamFactory([
                { data: JSON.stringify({ id: "1", question: "q", answer: "a" }) },
                { data: JSON.stringify({ id: "1", question: "q", answer: "a" }) },
            ]),
        });
        stream.connect((entry) => rows.push(entry.id), () => {});
        expect(rows).toEqual(["1"]);
    });

    it("ignores a malformed frame without throwing", () => {
        const rows: string[] = [];
        const stream = createQaStream({
            baseUrl: "http://h",
            authHeader: () => undefined,
            streamSseImpl: fakeStreamFactory([{ data: "{not json" }]),
        });
        expect(() => stream.connect((e) => rows.push(e.id), () => {})).not.toThrow();
        expect(rows).toEqual([]);
    });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `cd DevDashboard/mobile && bun run test src/transport/qa-stream.test.ts`
Expected: FAIL — `createQaStream` not defined.

- [ ] **Step 3: Implement `qa-stream.ts` (full code)**

```typescript
import type { QaEntry } from "@app/dev-dashboard/contract";
import { QA_STREAM_PATH } from "@app/dev-dashboard/contract";
import { SafeJSON } from "@app/utils/json";
import { streamSse as defaultStreamSse, type SseEvent, type StreamSseOptions } from "./sse-parser";
import type { QaStream, QaStreamStatus } from "./Transport";

type StreamSseImpl = (opts: StreamSseOptions) => { close: () => void };

export interface QaStreamOptions {
    baseUrl: string;
    authHeader: () => string | undefined;
    /** Override for tests / the E2E decorator. Defaults to expo/fetch streamSse. */
    streamSseImpl?: StreamSseImpl;
}

export function createQaStream(opts: QaStreamOptions): QaStream {
    const streamImpl = opts.streamSseImpl ?? defaultStreamSse;
    const seen = new Set<string>();
    let handle: { close: () => void } | null = null;

    function parse(event: SseEvent): QaEntry | null {
        try {
            return SafeJSON.parse(event.data, { strict: true }) as QaEntry;
        } catch {
            return null;
        }
    }

    return {
        connect(onRow: (entry: QaEntry) => void, onStatus: (status: QaStreamStatus) => void) {
            onStatus("connecting");
            const auth = opts.authHeader();

            handle = streamImpl({
                url: `${opts.baseUrl}${QA_STREAM_PATH}`,
                headers: auth ? { Authorization: auth } : undefined,
                onOpen: () => onStatus("open"),
                onError: () => onStatus("error"),
                onEvent: (event) => {
                    const entry = parse(event);

                    if (!entry || seen.has(entry.id)) {
                        return;
                    }

                    seen.add(entry.id);
                    onRow(entry);
                },
            });
        },
        close() {
            handle?.close();
            handle = null;
        },
    };
}
```

> **AppState resync (wired by the consuming hook in plan 07, noted here for completeness):** the QA
> screen subscribes to `AppState`; on `"active"` it calls `stream.close()` then `stream.connect(...)`
> AND re-runs the TanStack Query for `paths.qaLog(...)`, merging entries whose `id` is not in `seen`.
> The `seen` Set above makes the merge idempotent. This matches the web (file 04).

- [ ] **Step 4: Run to confirm it passes**

Run: `cd DevDashboard/mobile && bun run test src/transport/qa-stream.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add DevDashboard/mobile/src/transport/qa-stream.ts DevDashboard/mobile/src/transport/qa-stream.test.ts
git commit -m "feat(dd-mobile): QaStream over expo/fetch SSE with id-dedupe resync"
```

---

### Task 4: `TerminalTransport` over `partysocket` (reconnect/backoff/heartbeat/AppState)

> ttyd rides a WebSocket (research file 04). `partysocket` gives reconnect+backoff+buffer over the
> global `WebSocket`; we add an app-level ping/pong heartbeat + AppState teardown. Backgrounding
> kills sockets by OS design (file 04) — tmux/cmux hold the session, ttyd replays scrollback on
> reattach. The pure heartbeat reducer is unit-tested; the socket wiring is thin.

**Files:**
- Create: `DevDashboard/mobile/src/transport/terminal-ws.ts`
- Test: `DevDashboard/mobile/src/transport/terminal-ws.test.ts`

- [ ] **Step 1: Install partysocket (pure JS — bun add is allowed here)**

Run: `cd DevDashboard/mobile && bun add partysocket`
Expected: `partysocket` in `package.json` (research file 04 pinned ~1.1.19).

- [ ] **Step 2: Write the failing test (heartbeat reducer + a fake socket)**

```typescript
import { describe, expect, it } from "@jest/globals";
import { heartbeatReducer, type HeartbeatState } from "../src/transport/terminal-ws";

describe("heartbeatReducer", () => {
    const initial: HeartbeatState = { pendingPings: 0, dead: false };

    it("counts an outgoing ping", () => {
        const s = heartbeatReducer(initial, { type: "ping-sent" });
        expect(s.pendingPings).toBe(1);
    });

    it("clears pending pings on pong", () => {
        const s = heartbeatReducer({ pendingPings: 2, dead: false }, { type: "pong" });
        expect(s.pendingPings).toBe(0);
    });

    it("marks dead after 2 missed pongs", () => {
        let s = heartbeatReducer(initial, { type: "ping-sent" });
        s = heartbeatReducer(s, { type: "ping-sent" });
        expect(s.dead).toBe(true);
    });
});
```

- [ ] **Step 3: Run to confirm it fails**

Run: `cd DevDashboard/mobile && bun run test src/transport/terminal-ws.test.ts`
Expected: FAIL — `heartbeatReducer` not defined.

- [ ] **Step 4: Implement `terminal-ws.ts` (full code)**

```typescript
import { AppState, type AppStateStatus } from "react-native";
import { WebSocket as PartySocket } from "partysocket";
import type { TerminalStatus, TerminalTransport } from "./Transport";

const HEARTBEAT_INTERVAL_MS = 25_000;
const MAX_MISSED_PONGS = 2;

export interface HeartbeatState {
    pendingPings: number;
    dead: boolean;
}

export type HeartbeatAction = { type: "ping-sent" } | { type: "pong" } | { type: "reset" };

/** Pure: a ping with >= MAX_MISSED_PONGS outstanding means the link is dead. */
export function heartbeatReducer(state: HeartbeatState, action: HeartbeatAction): HeartbeatState {
    if (action.type === "pong" || action.type === "reset") {
        return { pendingPings: 0, dead: false };
    }

    const pendingPings = state.pendingPings + 1;

    return { pendingPings, dead: pendingPings >= MAX_MISSED_PONGS };
}

export interface TerminalTransportOptions {
    /** ws:// or wss:// URL to the ttyd session (already tier-resolved). */
    wsUrl: string;
    /** ttyd uses the "tty" subprotocol; auth cookie/token is planted by the renderer (plan 06). */
    protocols?: string[];
    /** Test seam: construct a fake socket. Defaults to PartySocket. */
    socketFactory?: (url: string, protocols?: string[]) => PartySocket;
}

export function createTerminalTransport(opts: TerminalTransportOptions): TerminalTransport {
    const make = opts.socketFactory ?? ((url, protocols) => new PartySocket({ url, protocols }));
    let status: TerminalStatus = "connecting";
    let heartbeat: HeartbeatState = { pendingPings: 0, dead: false };
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    const messageHandlers: Array<(d: string | ArrayBuffer) => void> = [];
    const statusHandlers: Array<(s: TerminalStatus) => void> = [];

    const socket = make(opts.wsUrl, opts.protocols ?? ["tty"]);
    socket.binaryType = "arraybuffer";

    function setStatus(next: TerminalStatus): void {
        status = next;
        for (const h of statusHandlers) {
            h(next);
        }
    }

    function startHeartbeat(): void {
        stopHeartbeat();
        heartbeatTimer = setInterval(() => {
            heartbeat = heartbeatReducer(heartbeat, { type: "ping-sent" });

            if (heartbeat.dead) {
                socket.reconnect();
                heartbeat = heartbeatReducer(heartbeat, { type: "reset" });
                return;
            }

            try {
                socket.send(" ping");
            } catch {
                // socket closed between the check and the send; reconnect loop handles it
            }
        }, HEARTBEAT_INTERVAL_MS);
    }

    function stopHeartbeat(): void {
        if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
        }
    }

    socket.addEventListener("open", () => {
        heartbeat = heartbeatReducer(heartbeat, { type: "reset" });
        setStatus("open");
        startHeartbeat();
    });

    socket.addEventListener("message", (ev: MessageEvent) => {
        if (typeof ev.data === "string" && ev.data === " pong") {
            heartbeat = heartbeatReducer(heartbeat, { type: "pong" });
            return;
        }

        for (const h of messageHandlers) {
            h(ev.data as string | ArrayBuffer);
        }
    });

    socket.addEventListener("close", () => setStatus("reconnecting"));
    socket.addEventListener("error", () => setStatus("reconnecting"));

    const appStateSub = AppState.addEventListener("change", (next: AppStateStatus) => {
        if (next === "background" || next === "inactive") {
            stopHeartbeat();
            socket.close();
            setStatus("closed");
            return;
        }

        if (next === "active" && status === "closed") {
            socket.reconnect();
            setStatus("connecting");
        }
    });

    return {
        get status() {
            return status;
        },
        send(data) {
            socket.send(data);
        },
        onMessage(handler) {
            messageHandlers.push(handler);
        },
        onStatus(handler) {
            statusHandlers.push(handler);
            handler(status);
        },
        close() {
            stopHeartbeat();
            appStateSub.remove();
            socket.close();
            setStatus("closed");
        },
    };
}
```

- [ ] **Step 5: Run to confirm it passes**

Run: `cd DevDashboard/mobile && bun run test src/transport/terminal-ws.test.ts`
Expected: PASS (3 reducer tests). The socket wiring is exercised by the plan-06 terminal Appium spec.

- [ ] **Step 6: Commit**

```bash
git add DevDashboard/mobile/src/transport/terminal-ws.ts DevDashboard/mobile/src/transport/terminal-ws.test.ts DevDashboard/mobile/package.json
git commit -m "feat(dd-mobile): TerminalTransport over partysocket + heartbeat + AppState teardown"
```

---

### Task 5: `PlainTransport` base (shared by LAN / Tailscale / self-cloudflared)

> The three plaintext-honest tiers differ only in how `baseUrl()` and `reachable()` resolve. They
> share everything else: build the `@devdashboard/contract` client with `expo/fetch`, inject the
> `QaStream` (Task 3) as the SSE factory, and produce a `TerminalTransport` (Task 4). This base
> implements the full `Transport` (Task 1) given a resolved base URL + auth + a reachability probe.

**Files:**
- Create: `DevDashboard/mobile/src/transport/plain-transport.ts`
- Test: `DevDashboard/mobile/src/transport/plain-transport.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "@jest/globals";
import { createPlainTransport } from "../src/transport/plain-transport";

describe("createPlainTransport", () => {
    it("exposes the tier, baseUrl, and authHeader it was built with", () => {
        const t = createPlainTransport({
            tier: "lan",
            baseUrl: "http://192.168.1.5:3042",
            authHeader: () => "Basic abc",
            probe: async () => true,
        });
        expect(t.tier).toBe("lan");
        expect(t.baseUrl()).toBe("http://192.168.1.5:3042");
        expect(t.authHeader()).toBe("Basic abc");
    });

    it("delegates reachable() to the injected probe", async () => {
        let probed = 0;
        const t = createPlainTransport({
            tier: "tailscale",
            baseUrl: "http://mac.tail.ts.net:3042",
            authHeader: () => undefined,
            probe: async () => {
                probed++;
                return false;
            },
        });
        expect(await t.reachable()).toBe(false);
        expect(probed).toBe(1);
    });

    it("openTerminal builds a ws:// URL from an http base", () => {
        const t = createPlainTransport({
            tier: "lan",
            baseUrl: "http://192.168.1.5:3042",
            authHeader: () => undefined,
            probe: async () => true,
            terminalFactory: (o) => ({ wsUrl: o.wsUrl }) as never,
        });
        const term = t.openTerminal("abc-123") as unknown as { wsUrl: string };
        expect(term.wsUrl).toBe("ws://192.168.1.5:3042/ttyd/abc-123/ws");
    });

    it("openTerminal builds wss:// from an https base", () => {
        const t = createPlainTransport({
            tier: "cloudflared-self",
            baseUrl: "https://mac.example.com",
            authHeader: () => undefined,
            probe: async () => true,
            terminalFactory: (o) => ({ wsUrl: o.wsUrl }) as never,
        });
        const term = t.openTerminal("abc-123") as unknown as { wsUrl: string };
        expect(term.wsUrl).toBe("wss://mac.example.com/ttyd/abc-123/ws");
    });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `cd DevDashboard/mobile && bun run test src/transport/plain-transport.test.ts`
Expected: FAIL — `createPlainTransport` not defined.

- [ ] **Step 3: Implement `plain-transport.ts` (full code)**

```typescript
import { createDashboardClient, type DashboardClient, type EventSourceLike } from "@app/dev-dashboard/contract";
import { fetch as expoFetch } from "expo/fetch";
import { createQaStream } from "./qa-stream";
import { createTerminalTransport, type TerminalTransportOptions } from "./terminal-ws";
import type { QaStream, TerminalTransport, Transport, TransportTier } from "./Transport";

export interface PlainTransportOptions {
    tier: TransportTier;
    /** Resolved per tier (LAN ip / tailnet host / tunnel url). No trailing slash. */
    baseUrl: string;
    authHeader: () => string | undefined;
    /** Tier-specific liveness probe (mDNS hit / tailnet GET / tunnel GET). */
    probe: () => Promise<boolean>;
    /** Test seam for the WS transport. */
    terminalFactory?: (opts: TerminalTransportOptions) => TerminalTransport;
}

/** http(s)://host -> ws(s)://host/ttyd/<id>/ws (mirrors the web ttyd path). */
function ttydWsUrl(baseUrl: string, sessionId: string): string {
    const wsBase = baseUrl.replace(/^http/, "ws");
    return `${wsBase}/ttyd/${sessionId}/ws`;
}

export function createPlainTransport(opts: PlainTransportOptions): Transport {
    const makeTerminal = opts.terminalFactory ?? createTerminalTransport;

    function client(): DashboardClient {
        return createDashboardClient({
            baseUrl: opts.baseUrl,
            fetch: ((url: string, init?: RequestInit) => expoFetch(url, init as never)) as unknown as typeof fetch,
            authHeader: opts.authHeader,
            // The contract's SSE helper wants an EventSource-like; we supply our expo/fetch QaStream
            // through a thin adapter so the contract stays transport-agnostic (ADR §3).
            eventSourceFactory: (url: string): EventSourceLike => {
                const qa = createQaStream({ baseUrl: "", authHeader: opts.authHeader });
                let onmessage: ((ev: { data: string }) => void) | null = null;
                qa.connect((entry) => onmessage?.({ data: JSON.stringify(entry) }), () => {});

                return {
                    close: () => qa.close(),
                    get onmessage() {
                        return onmessage;
                    },
                    set onmessage(handler) {
                        onmessage = handler;
                    },
                    onerror: null,
                };
            },
        });
    }

    return {
        tier: opts.tier,
        baseUrl: () => opts.baseUrl,
        authHeader: opts.authHeader,
        reachable: () => opts.probe(),
        client,
        streamQa(): QaStream {
            return createQaStream({ baseUrl: opts.baseUrl, authHeader: opts.authHeader });
        },
        openTerminal(sessionId: string): TerminalTransport {
            return makeTerminal({ wsUrl: ttydWsUrl(opts.baseUrl, sessionId), protocols: ["tty"] });
        },
    };
}
```

> NOTE: the QA screen (plan 07) consumes `transport.streamQa()` directly (the clean path). The
> `eventSourceFactory` adapter above exists only so the *contract client's* `c.qa.subscribe(...)`
> also works on RN, keeping web/mobile call-site parity (ADR §3). Plan 07 picks one; both compile.

- [ ] **Step 4: Run to confirm it passes**

Run: `cd DevDashboard/mobile && bun run test src/transport/plain-transport.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add DevDashboard/mobile/src/transport/plain-transport.ts DevDashboard/mobile/src/transport/plain-transport.test.ts
git commit -m "feat(dd-mobile): PlainTransport base (contract client + SSE + ttyd WS)"
```

---

### Task 6: Tier 1 — LAN/mDNS (Agent advertiser + mobile zeroconf discovery)

> Two halves: (6a) the **Agent** advertises `_devdashboard._tcp` so the phone can find it; (6b) the
> **mobile** app discovers it via `react-native-zeroconf` and builds a `PlainTransport`. Research
> file 04: zeroconf is New-Arch via the Interop Layer; needs dev-client + local-network perms;
> Android mDNS is flaky → prefer DNSSD, AppState rescan; iOS works well.

**Files:**
- Create: `src/dev-dashboard/server/transport/mdns-advertiser.ts` (Agent)
- Test: `src/dev-dashboard/server/transport/mdns-advertiser.test.ts`
- Create: `DevDashboard/mobile/src/transport/lan-discovery.ts` (mobile)
- Create: `DevDashboard/mobile/src/transport/tiers/lan.ts`
- Modify: `src/dev-dashboard/server/serve.ts`, `DevDashboard/mobile/app.config.ts`

#### 6a — Agent advertiser

- [ ] **Step 1: Confirm the Bonjour approach (no new heavy dep)**

Run: `which dns-sd` (macOS ships `dns-sd`; the Agent is macOS-today per ADR §1)
Expected: `/usr/bin/dns-sd`. We advertise by spawning `dns-sd -R "DevDashboard" _devdashboard._tcp . <port> path=/` and
killing it on shutdown. (If the product later targets Linux, swap in `bonjour-service` (npm) behind
the same interface — note it, don't build it now.)

- [ ] **Step 2: Write the failing test (command builder is pure + unit-testable)**

```typescript
import { describe, expect, it } from "bun:test";
import { buildDnsSdRegisterArgs } from "@app/dev-dashboard/server/transport/mdns-advertiser";

describe("buildDnsSdRegisterArgs", () => {
    it("registers _devdashboard._tcp on the given port with a path TXT record", () => {
        const args = buildDnsSdRegisterArgs({ instanceName: "Martin's Mac", port: 3042 });
        expect(args).toEqual(["-R", "Martin's Mac", "_devdashboard._tcp", ".", "3042", "path=/"]);
    });

    it("includes a tier TXT record when given", () => {
        const args = buildDnsSdRegisterArgs({ instanceName: "Mac", port: 3042, txt: { v: "1" } });
        expect(args).toContain("v=1");
    });
});
```

- [ ] **Step 3: Run to confirm it fails**

Run: `bun test src/dev-dashboard/server/transport/mdns-advertiser.test.ts`
Expected: FAIL — `buildDnsSdRegisterArgs` not defined.

- [ ] **Step 4: Implement `mdns-advertiser.ts` (full code)**

```typescript
import { logger } from "@app/logger";
import type { Subprocess } from "bun";

export interface MdnsRegisterOptions {
    instanceName: string;
    port: number;
    serviceType?: string;
    txt?: Record<string, string>;
}

const DEFAULT_SERVICE_TYPE = "_devdashboard._tcp";

/** Pure: the `dns-sd -R` argv. Unit-tested; the spawn wraps this. */
export function buildDnsSdRegisterArgs(opts: MdnsRegisterOptions): string[] {
    const args = ["-R", opts.instanceName, opts.serviceType ?? DEFAULT_SERVICE_TYPE, ".", String(opts.port), "path=/"];

    for (const [k, v] of Object.entries(opts.txt ?? {})) {
        args.push(`${k}=${v}`);
    }

    return args;
}

export interface MdnsAdvertiser {
    stop(): void;
}

/** Advertises the Agent over Bonjour via macOS `dns-sd`. Returns a stop handle. */
export function startMdnsAdvertiser(opts: MdnsRegisterOptions): MdnsAdvertiser {
    const args = buildDnsSdRegisterArgs(opts);
    let proc: Subprocess | null = null;

    try {
        proc = Bun.spawn(["dns-sd", ...args], { stdout: "ignore", stderr: "ignore" });
        logger.info({ port: opts.port, service: opts.serviceType ?? DEFAULT_SERVICE_TYPE }, "dev-dashboard: mDNS advertiser started");
    } catch (err) {
        logger.warn({ err }, "dev-dashboard: mDNS advertiser failed to start (LAN discovery disabled)");
    }

    return {
        stop() {
            try {
                proc?.kill();
            } catch (err) {
                logger.debug({ err }, "dev-dashboard: mDNS advertiser stop failed");
            }
        },
    };
}
```

- [ ] **Step 5: Run to confirm it passes + wire into serve.ts**

Run: `bun test src/dev-dashboard/server/transport/mdns-advertiser.test.ts`
Expected: PASS (2 tests).

In `serve.ts`, after `Bun.serve(...)`, add (guarded by an `advertiseMdns` opt, default true):

```typescript
import { startMdnsAdvertiser } from "@app/dev-dashboard/server/transport/mdns-advertiser";
import { hostname } from "node:os";
// ...inside serveAgent, after the server is listening:
const advertiser = opts.advertiseMdns === false ? null : startMdnsAdvertiser({ instanceName: hostname(), port: server.port, txt: { v: "1" } });
process.on("SIGINT", () => advertiser?.stop());
process.on("SIGTERM", () => advertiser?.stop());
```

- [ ] **Step 6: Commit**

```bash
git add src/dev-dashboard/server/transport/mdns-advertiser.ts src/dev-dashboard/server/transport/mdns-advertiser.test.ts src/dev-dashboard/server/serve.ts
git commit -m "feat(dd-agent): advertise _devdashboard._tcp over Bonjour (LAN discovery)"
```

#### 6b — Mobile zeroconf discovery + LAN tier

- [ ] **Step 7: Install + configure react-native-zeroconf (native — expo install)**

Run: `cd DevDashboard/mobile && npx expo install react-native-zeroconf`
Then add to `app.config.ts` (config plugin + perms):

```typescript
// inside the expo config object:
ios: {
    infoPlist: {
        NSLocalNetworkUsageDescription: "DevDashboard discovers your Mac's agent on the local network.",
        NSBonjourServices: ["_devdashboard._tcp"],
    },
},
android: {
    permissions: [
        "android.permission.INTERNET",
        "android.permission.ACCESS_NETWORK_STATE",
        "android.permission.ACCESS_WIFI_STATE",
        "android.permission.CHANGE_WIFI_MULTICAST_STATE",
    ],
},
plugins: [
    // ...existing
    "react-native-zeroconf",
],
```

Expected: a `prebuild` regenerates the native projects with the plist + perms. (Verify via
`npx expo prebuild -p ios --no-install` then `rg NSBonjourServices ios/`.)

- [ ] **Step 8: Implement `lan-discovery.ts` (full code — no test; native module, validated by Appium)**

```typescript
import { useEffect, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";
import Zeroconf, { type Service } from "react-native-zeroconf";

export interface DiscoveredAgent {
    name: string;
    host: string;
    port: number;
    /** http://host:port */
    baseUrl: string;
}

const SERVICE_TYPE = "devdashboard";

function toAgent(service: Service): DiscoveredAgent | null {
    const host = service.addresses?.[0] ?? service.host;

    if (!host || !service.port) {
        return null;
    }

    return { name: service.name, host, port: service.port, baseUrl: `http://${host}:${service.port}` };
}

/** Scans for `_devdashboard._tcp`. Re-scans on AppState resume (Android mDNS dies on lock). */
export function useZeroconfDiscovery(): { agents: DiscoveredAgent[]; scanning: boolean; rescan: () => void } {
    const [agents, setAgents] = useState<DiscoveredAgent[]>([]);
    const [scanning, setScanning] = useState(false);

    useEffect(() => {
        const zeroconf = new Zeroconf();

        const startScan = () => {
            setScanning(true);
            zeroconf.scan(SERVICE_TYPE, "tcp", "local.");
        };

        zeroconf.on("resolved", (service: Service) => {
            const agent = toAgent(service);

            if (agent) {
                setAgents((prev) => (prev.some((a) => a.baseUrl === agent.baseUrl) ? prev : [...prev, agent]));
            }
        });

        zeroconf.on("error", () => setScanning(false));
        startScan();

        const sub = AppState.addEventListener("change", (next: AppStateStatus) => {
            if (next === "active") {
                setAgents([]);
                zeroconf.stop();
                startScan();
            }
        });

        return () => {
            sub.remove();
            zeroconf.stop();
            zeroconf.removeDeviceListeners();
        };
    }, []);

    return { agents, scanning, rescan: () => setAgents([]) };
}
```

- [ ] **Step 9: Implement the LAN tier (`tiers/lan.ts`)**

```typescript
import { makeBasicAuthHeader } from "@app/dev-dashboard/contract";
import { fetch as expoFetch } from "expo/fetch";
import { createPlainTransport } from "../plain-transport";
import type { DiscoveredAgent } from "../lan-discovery";
import type { Transport } from "../Transport";

export interface LanCredentials {
    username: string;
    password: string;
}

export function createLanTransport(agent: DiscoveredAgent, creds: LanCredentials): Transport {
    const authHeader = () => makeBasicAuthHeader(creds);

    return createPlainTransport({
        tier: "lan",
        baseUrl: agent.baseUrl,
        authHeader,
        probe: async () => {
            try {
                const res = await expoFetch(`${agent.baseUrl}/api/system/pulse`, {
                    method: "GET",
                    headers: { Authorization: authHeader() },
                    signal: AbortSignal.timeout(2500),
                });
                return res.ok;
            } catch {
                return false;
            }
        },
    });
}
```

- [ ] **Step 10: Typecheck + commit**

Run: `cd DevDashboard/mobile && bunx tsgo --noEmit | rg "transport/(lan|tiers/lan)"`
Expected: no errors.

```bash
git add DevDashboard/mobile/src/transport/lan-discovery.ts DevDashboard/mobile/src/transport/tiers/lan.ts DevDashboard/mobile/app.config.ts DevDashboard/mobile/package.json
git commit -m "feat(dd-mobile): LAN tier — zeroconf discovery + PlainTransport (Tier 1)"
```

---

### Task 7: Tier 2 — Tailscale (reachability probe + deep-link, trust-max)

> Per research file 04 + verified tailscale#7240: **no embeddable Tailscale SDK** (`tsnet` is
> Go-only). The user runs the Tailscale app; we connect to the **tailnet hostname** and only
> *detect reachability* + *deep-link to Tailscale*. Verified (web, 2026-05): iOS has **no public
> URL scheme to programmatically start the VPN** — so the deep-link opens the installed Tailscale
> app if present (its store URL), else routes to the App Store; we never claim to toggle the VPN.

**Files:**
- Create: `DevDashboard/mobile/src/transport/reachability.ts` (+ test)
- Create: `DevDashboard/mobile/src/transport/tiers/tailscale.ts`

- [ ] **Step 1: Write the failing reachability-reducer test (pure)**

```typescript
import { describe, expect, it } from "@jest/globals";
import { reachabilityReducer, type ReachState } from "../src/transport/reachability";

describe("reachabilityReducer", () => {
    it("starts probing", () => {
        expect(reachabilityReducer({ kind: "idle" }, { type: "probe-start" })).toEqual({ kind: "probing" });
    });

    it("probe success -> reachable", () => {
        expect(reachabilityReducer({ kind: "probing" }, { type: "probe-ok" })).toEqual({ kind: "reachable" });
    });

    it("a tailscale probe failure -> needs-vpn (not generic unreachable)", () => {
        const s = reachabilityReducer({ kind: "probing" }, { type: "probe-fail", tier: "tailscale" });
        expect(s).toEqual({ kind: "needs-vpn" });
    });

    it("a managed probe failure with no keys -> needs-pair", () => {
        const s = reachabilityReducer({ kind: "probing" }, { type: "probe-fail", tier: "managed", paired: false });
        expect(s).toEqual({ kind: "needs-pair" });
    });

    it("a lan probe failure -> unreachable", () => {
        const s = reachabilityReducer({ kind: "probing" }, { type: "probe-fail", tier: "lan" });
        expect(s).toEqual({ kind: "unreachable" });
    });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `cd DevDashboard/mobile && bun run test src/transport/reachability.test.ts`
Expected: FAIL — `reachabilityReducer` not defined.

- [ ] **Step 3: Implement `reachability.ts` (full code)**

```typescript
import type { TransportTier } from "./Transport";

export type ReachState =
    | { kind: "idle" }
    | { kind: "probing" }
    | { kind: "reachable" }
    | { kind: "unreachable" }
    | { kind: "needs-vpn" }
    | { kind: "needs-pair" };

export type ReachAction =
    | { type: "probe-start" }
    | { type: "probe-ok" }
    | { type: "probe-fail"; tier: TransportTier; paired?: boolean };

/** Pure FSM mapping a tier-specific probe failure to the right user-facing state. */
export function reachabilityReducer(_state: ReachState, action: ReachAction): ReachState {
    if (action.type === "probe-start") {
        return { kind: "probing" };
    }

    if (action.type === "probe-ok") {
        return { kind: "reachable" };
    }

    if (action.tier === "tailscale") {
        return { kind: "needs-vpn" };
    }

    if (action.tier === "managed" && action.paired === false) {
        return { kind: "needs-pair" };
    }

    return { kind: "unreachable" };
}
```

- [ ] **Step 4: Run to confirm it passes**

Run: `cd DevDashboard/mobile && bun run test src/transport/reachability.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Implement the Tailscale tier (`tiers/tailscale.ts`)**

```typescript
import { makeBasicAuthHeader } from "@app/dev-dashboard/contract";
import { fetch as expoFetch } from "expo/fetch";
import * as Linking from "expo-linking";
import { createPlainTransport } from "../plain-transport";
import type { Transport } from "../Transport";

/** Tailscale's iOS/Android app store URL — opens the app if installed, else the store. */
const TAILSCALE_APP_URL = "https://apps.apple.com/app/tailscale/id1470499037";

export interface TailscaleConfig {
    /** e.g. "mac.tailnet-name.ts.net" or "100.x.y.z" — the user's tailnet host. */
    tailnetHost: string;
    port: number;
    username: string;
    password: string;
}

/** Opens Tailscale (or its store page). We CANNOT start the VPN programmatically on iOS (verified). */
export async function openTailscaleApp(): Promise<void> {
    await Linking.openURL(TAILSCALE_APP_URL);
}

export function createTailscaleTransport(config: TailscaleConfig): Transport {
    const baseUrl = `http://${config.tailnetHost}:${config.port}`;
    const authHeader = () => makeBasicAuthHeader({ username: config.username, password: config.password });

    return createPlainTransport({
        tier: "tailscale",
        baseUrl,
        authHeader,
        // When the VPN is down the tailnet host does not resolve/route -> probe fails ->
        // the reachability reducer maps "tailscale" failure to needs-vpn (Step 3).
        probe: async () => {
            try {
                const res = await expoFetch(`${baseUrl}/api/system/pulse`, {
                    method: "GET",
                    headers: { Authorization: authHeader() },
                    signal: AbortSignal.timeout(3000),
                });
                return res.ok;
            } catch {
                return false;
            }
        },
    });
}
```

- [ ] **Step 6: Install expo-linking + typecheck + commit**

Run: `cd DevDashboard/mobile && npx expo install expo-linking` (likely already present via expo-router)
Run: `cd DevDashboard/mobile && bunx tsgo --noEmit | rg "transport/(reachability|tiers/tailscale)"`
Expected: no errors.

```bash
git add DevDashboard/mobile/src/transport/reachability.ts DevDashboard/mobile/src/transport/reachability.test.ts DevDashboard/mobile/src/transport/tiers/tailscale.ts
git commit -m "feat(dd-mobile): Tailscale tier — tailnet probe + deep-link + reachability FSM (Tier 2)"
```

---

### Task 8: Tier 3 — Self-hosted cloudflared (Agent CLI wizard + pairing QR)

> *User-requested, near-zero-friction.* The **Agent** ships `tools dev-dashboard tunnel setup`: detect/
> install `cloudflared`, walk CF login, create + route a named tunnel, persist config, emit a pairing
> QR the mobile app scans. The user owns *their* CF account → the vendor is never in the data path
> (ADR §4 tier 3). Verified CLI (web, 2026-05): `cloudflared tunnel login`, `cloudflared tunnel
> create <name>`, `cloudflared tunnel route dns <name> <hostname>`, config in `~/.cloudflared/`.

**Files:**
- Create: `src/dev-dashboard/lib/tunnel/cloudflared.ts` (+ test)
- Create: `src/dev-dashboard/lib/tunnel/pairing.ts` (+ test)
- Create: `src/dev-dashboard/commands/tunnel.ts`
- Modify: `src/dev-dashboard/index.ts`

- [ ] **Step 1: Write the failing test (pure CLI arg builders + detection)**

```typescript
import { describe, expect, it } from "bun:test";
import { buildCreateArgs, buildRouteDnsArgs, buildRunArgs, parseTunnelId } from "@app/dev-dashboard/lib/tunnel/cloudflared";

describe("cloudflared arg builders", () => {
    it("creates a named tunnel", () => {
        expect(buildCreateArgs("devdashboard")).toEqual(["tunnel", "create", "devdashboard"]);
    });

    it("routes DNS to a hostname", () => {
        expect(buildRouteDnsArgs("devdashboard", "mac.example.com")).toEqual([
            "tunnel", "route", "dns", "devdashboard", "mac.example.com",
        ]);
    });

    it("runs a tunnel pointed at a local port via --url", () => {
        expect(buildRunArgs("devdashboard", 3042)).toEqual([
            "tunnel", "run", "--url", "http://127.0.0.1:3042", "devdashboard",
        ]);
    });

    it("parses the tunnel id out of `tunnel create` stdout", () => {
        const out = "Created tunnel devdashboard with id 6ff42ae2-765d-4adf-8112-31c55c1551ef";
        expect(parseTunnelId(out)).toBe("6ff42ae2-765d-4adf-8112-31c55c1551ef");
    });

    it("returns null when no id is present", () => {
        expect(parseTunnelId("nothing here")).toBeNull();
    });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `bun test src/dev-dashboard/lib/tunnel/cloudflared.test.ts`
Expected: FAIL — module / exports missing.

- [ ] **Step 3: Implement `cloudflared.ts` (full code)**

```typescript
import { logger } from "@app/logger";

const TUNNEL_UUID_RE = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;

export function buildCreateArgs(name: string): string[] {
    return ["tunnel", "create", name];
}

export function buildRouteDnsArgs(name: string, hostname: string): string[] {
    return ["tunnel", "route", "dns", name, hostname];
}

export function buildRunArgs(name: string, port: number): string[] {
    return ["tunnel", "run", "--url", `http://127.0.0.1:${port}`, name];
}

export function parseTunnelId(stdout: string): string | null {
    return stdout.match(TUNNEL_UUID_RE)?.[1] ?? null;
}

export async function detectCloudflared(): Promise<{ installed: boolean; version?: string }> {
    try {
        const proc = Bun.spawn(["cloudflared", "--version"], { stdout: "pipe", stderr: "ignore" });
        const out = await new Response(proc.stdout).text();
        await proc.exited;

        return { installed: proc.exitCode === 0, version: out.trim() || undefined };
    } catch {
        return { installed: false };
    }
}

/** Best-effort install on macOS via Homebrew; returns true on success. */
export async function installCloudflared(): Promise<boolean> {
    try {
        const proc = Bun.spawn(["brew", "install", "cloudflared"], { stdout: "inherit", stderr: "inherit" });
        await proc.exited;

        return proc.exitCode === 0;
    } catch (err) {
        logger.warn({ err }, "dev-dashboard: cloudflared install via brew failed");
        return false;
    }
}

/** Runs a cloudflared subcommand, returning {code, stdout, stderr}. */
export async function runCloudflared(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn(["cloudflared", ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    logger.info({ args, code: proc.exitCode }, "dev-dashboard: cloudflared command");

    return { code: proc.exitCode ?? -1, stdout, stderr };
}

/** `cloudflared tunnel login` opens a browser; we surface the URL it prints and wait. */
export async function loginCloudflared(): Promise<{ code: number; stdout: string; stderr: string }> {
    return runCloudflared(["tunnel", "login"]);
}
```

- [ ] **Step 4: Run to confirm it passes**

Run: `bun test src/dev-dashboard/lib/tunnel/cloudflared.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the pairing failing test (codec lives in the contract per Task 0; this verifies the lib re-export)**

```typescript
import { describe, expect, it } from "bun:test";
// imports resolve through lib/tunnel/pairing.ts's re-export of the contract codec (Task 0 + Step 6).
import { buildPairingPayload, parsePairingPayload } from "@app/dev-dashboard/lib/tunnel/pairing";

describe("pairing payload", () => {
    it("round-trips a self-cloudflared pairing payload", () => {
        const payload = buildPairingPayload({
            tier: "cloudflared-self",
            baseUrl: "https://mac.example.com",
            username: "martin",
        });
        const parsed = parsePairingPayload(payload);
        expect(parsed).toEqual({ tier: "cloudflared-self", baseUrl: "https://mac.example.com", username: "martin" });
    });

    it("rejects a malformed payload", () => {
        expect(parsePairingPayload("not-a-dd-pairing-uri")).toBeNull();
    });

    it("rejects a wrong scheme", () => {
        expect(parsePairingPayload("https://example.com")).toBeNull();
    });
});
```

- [ ] **Step 6: Implement `pairing.ts` (full code — re-exports the contract codec + adds disk helpers)**

> The pairing codec (`buildPairingPayload`/`parsePairingPayload`/`PairingPayload`/`PairingTier`) is
> defined in `contract/pairing.ts` (Task 0). This file ONLY re-exports it for the Agent and adds the
> disk-touching `persist`/`load` helpers (which use `node:os` + `Bun` and therefore must NOT be in the
> contract). No duplicate definitions.

```typescript
import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";

export {
    buildPairingPayload,
    parsePairingPayload,
    type PairingPayload,
    type PairingTier,
} from "@app/dev-dashboard/contract/pairing";

export interface PersistedTunnelConfig {
    tunnelName: string;
    tunnelId: string;
    hostname: string;
    localPort: number;
}

const TUNNEL_CONFIG_PATH = join(homedir(), ".genesis-tools", "dev-dashboard", "tunnel.json");

export async function persistTunnelConfig(config: PersistedTunnelConfig): Promise<void> {
    await Bun.write(TUNNEL_CONFIG_PATH, SafeJSON.stringify(config, null, 2));
    logger.info({ path: TUNNEL_CONFIG_PATH, tunnel: config.tunnelName }, "dev-dashboard: tunnel config persisted");
}

export async function loadTunnelConfig(): Promise<PersistedTunnelConfig | null> {
    const file = Bun.file(TUNNEL_CONFIG_PATH);

    if (!(await file.exists())) {
        return null;
    }

    return SafeJSON.parse(await file.text(), { strict: true }) as PersistedTunnelConfig;
}
```

- [ ] **Step 7: Run the pairing test**

Run: `bun test src/dev-dashboard/lib/tunnel/pairing.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 8: Implement the wizard command (`commands/tunnel.ts`)**

```typescript
import { intro, isCancel, log, note, outro, spinner, text } from "@clack/prompts";
import { getDashboardAuthCached } from "@app/dev-dashboard/config";
import {
    buildCreateArgs,
    buildRouteDnsArgs,
    detectCloudflared,
    installCloudflared,
    loginCloudflared,
    parseTunnelId,
    runCloudflared,
} from "@app/dev-dashboard/lib/tunnel/cloudflared";
import { buildPairingPayload, persistTunnelConfig } from "@app/dev-dashboard/lib/tunnel/pairing";
import { out } from "@app/logger";
import qrcode from "qrcode-terminal";

export async function runTunnelSetup(opts: { port: number }): Promise<void> {
    intro("DevDashboard — self-hosted Cloudflare Tunnel setup");

    const detected = await detectCloudflared();

    if (!detected.installed) {
        const s = spinner();
        s.start("cloudflared not found — installing via Homebrew");
        const ok = await installCloudflared();
        s.stop(ok ? "cloudflared installed" : "install failed");

        if (!ok) {
            note("Install cloudflared manually: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation", "Manual step");
            outro("Re-run `tools dev-dashboard tunnel setup` after installing.");
            return;
        }
    }

    log.step("A browser will open for Cloudflare login. Pick the domain you want to use.");
    const loginResult = await loginCloudflared();

    if (loginResult.code !== 0) {
        note(loginResult.stderr || "login failed", "Cloudflare login");
        outro("Login did not complete — try again.");
        return;
    }

    const hostname = await text({ message: "Public hostname for the dashboard", placeholder: "mac.yourdomain.com" });

    if (isCancel(hostname)) {
        outro("Cancelled.");
        return;
    }

    const tunnelName = "devdashboard";
    const create = await runCloudflared(buildCreateArgs(tunnelName));
    const tunnelId = parseTunnelId(`${create.stdout}\n${create.stderr}`);

    if (!tunnelId) {
        note(create.stderr || create.stdout, "tunnel create");
        outro("Could not create the tunnel.");
        return;
    }

    const route = await runCloudflared(buildRouteDnsArgs(tunnelName, String(hostname)));

    if (route.code !== 0) {
        note(route.stderr, "route dns");
        outro("DNS routing failed.");
        return;
    }

    await persistTunnelConfig({ tunnelName, tunnelId, hostname: String(hostname), localPort: opts.port });

    const provision = await getDashboardAuthCached();
    const pairingUri = buildPairingPayload({
        tier: "cloudflared-self",
        baseUrl: `https://${hostname}`,
        username: provision.auth.username,
    });

    note(`Tunnel '${tunnelName}' (${tunnelId}) routes ${hostname} -> 127.0.0.1:${opts.port}`, "Done");
    out.println("\nScan this QR in the DevDashboard mobile app to pair:\n");
    qrcode.generate(pairingUri, { small: true }, (qr) => out.println(qr));
    out.println(`\nOr paste this pairing URI:\n  ${pairingUri}\n`);
    note("Run the tunnel: `cloudflared tunnel run devdashboard` (or add it as a launchd/login service).", "Next");
    outro("Self-hosted tunnel ready — the vendor is never in your data path.");
}
```

- [ ] **Step 9: Register the subcommand in `index.ts` + install qrcode-terminal**

Run: `bun add qrcode-terminal` (pure JS — bun add allowed)
In `src/dev-dashboard/index.ts`:

```typescript
import { runTunnelSetup } from "@app/dev-dashboard/commands/tunnel";

const tunnel = program.command("tunnel").description("Manage remote access tunnels");
tunnel
    .command("setup")
    .description("Guided self-hosted Cloudflare Tunnel setup (emits a pairing QR)")
    .option("--port <port>", "local dashboard port", (v) => Number.parseInt(v, 10), 3042)
    .action(async (opts: { port: number }) => {
        await runTunnelSetup({ port: opts.port });
    });
```

- [ ] **Step 10: Smoke + commit**

Run: `tools dev-dashboard tunnel setup --port 3042` (interactive — verify it detects cloudflared and,
on a machine without a CF account, exits gracefully at the login step; the arg-builder + pairing unit
tests cover the non-interactive logic).
Run: `bun test src/dev-dashboard/lib/tunnel/`
Expected: all tunnel unit tests PASS.

```bash
git add src/dev-dashboard/lib/tunnel/ src/dev-dashboard/commands/tunnel.ts src/dev-dashboard/index.ts
git commit -m "feat(dd-agent): 'dev-dashboard tunnel setup' self-hosted cloudflared wizard + pairing QR (Tier 3)"
```

- [ ] **Step 11: Mobile self-cloudflared tier (`tiers/cloudflared.ts`)**

```typescript
import { makeBasicAuthHeader, type PairingPayload } from "@app/dev-dashboard/contract";
import { fetch as expoFetch } from "expo/fetch";
import { createPlainTransport } from "../plain-transport";
import type { Transport } from "../Transport";

export function createCloudflaredTransport(pairing: PairingPayload, password: string): Transport {
    const authHeader = () => makeBasicAuthHeader({ username: pairing.username, password });

    return createPlainTransport({
        tier: "cloudflared-self",
        baseUrl: pairing.baseUrl,
        authHeader,
        probe: async () => {
            try {
                const res = await expoFetch(`${pairing.baseUrl}/api/system/pulse`, {
                    method: "GET",
                    headers: { Authorization: authHeader() },
                    signal: AbortSignal.timeout(4000),
                });
                return res.ok;
            } catch {
                return false;
            }
        },
    });
}
```

```bash
git add DevDashboard/mobile/src/transport/tiers/cloudflared.ts
git commit -m "feat(dd-mobile): self-cloudflared tier — scanned pairing URI -> PlainTransport (Tier 3)"
```

---

## E2E sub-phase (Tasks 9-11) — app-layer encryption for the managed tier

> **This is a real crypto sub-phase, not hand-waving.** The managed tier puts a vendor relay (or CF
> tunnel on the *vendor's* account) in the path; the relay terminates TLS and would see plaintext.
> The "we can't see your data" claim survives ONLY with endpoint-to-endpoint encryption above the
> transport (ADR §4 tier 4, research file 04). **Key custody is the whole game:** X25519 keypairs are
> generated and stored ONLY on the phone (`expo-secure-store` → Keychain/Keystore) and the Mac (a
> 0600 key file); the vendor NEVER holds or escrows a private key. The pairing flow exchanges only
> *public* keys (Agent pubkey in the QR; phone pubkey via a device-code POST). Per-message AEAD =
> NaCl `crypto_box` (X25519 + XSalsa20-Poly1305). **Confirm the PROPOSED `tweetnacl` choice with the
> user before Step 1** (see the PROPOSED library decision section at the top).

### Task 9: Shared `BoxCipher` + `E2eEnvelope` codec (Agent + Mobile, identical wire format)

> Both endpoints must encode/decode the EXACT same envelope. We author the codec once on each side
> and lock them together with a **shared test-vector JSON** so they can never drift. `BoxCipher` is
> an interface so `tweetnacl` ↔ `react-native-libsodium` is a one-file swap (PROPOSED decision).

**Files:**
- Create: `src/dev-dashboard/lib/e2e/envelope.ts` (+ test) — Agent codec.
- Create: `src/dev-dashboard/lib/e2e/box.ts` (+ test) — Agent BoxCipher + on-disk keys.
- Create: `DevDashboard/mobile/src/transport/e2e/envelope.ts` (+ test) — Mobile codec (mirror).
- Create: `DevDashboard/mobile/src/transport/e2e/box-cipher.ts` (+ test) — Mobile BoxCipher + SecureStore keys.
- Create: `src/dev-dashboard/lib/e2e/test-vectors.json` — shared vectors (committed; both test suites read it).

- [ ] **Step 0: Benchmark the PROPOSED cipher on Hermes (gate the library choice)**

Before committing to `tweetnacl`, run a throughput micro-bench in the dev-client: encrypt+decrypt a
4 KB payload 200× with `nacl.box`/`nacl.box.open` and log the median ms. Target: < ~2 ms/op (terminal
frames are small + bursty; SSE rows are infrequent). If it blows the budget, switch `box-cipher.ts`
to `react-native-libsodium` (native) — the `BoxCipher` interface (Step 3) makes this a one-file
change. Record the number in the PR description. (This is the empirical check behind the PROPOSED
recommendation; do NOT skip it.)

- [ ] **Step 1: Install the PROPOSED cipher (after user confirm)**

Run: `cd DevDashboard/mobile && bun add tweetnacl tweetnacl-util` (pure JS; if PRNG needs seeding on
RN, `npx expo install expo-crypto` and seed `nacl.setPRNG` from `Crypto.getRandomValues`).
Agent: `bun add tweetnacl tweetnacl-util` at the repo root.

- [ ] **Step 2: Write the shared test vectors (`test-vectors.json`)**

```json
{
    "note": "Fixed keypairs + nonce so Agent and Mobile codecs are byte-identical. NEVER use these keys in production.",
    "alicePublicKey": "1ZP2qE8m3oXz7m0w2Q2GVxk0F3JZ5l8wQv5b9cZqQ2A=",
    "alicePrivateKey": "kQ2xY8H4n9vT0a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5=",
    "bobPublicKey": "9aZ7Yk4m3oXz7m0w2Q2GVxk0F3JZ5l8wQv5b9cZqQ2A=",
    "bobPrivateKey": "aB2xY8H4n9vT0a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5=",
    "nonce": "AAECAwQFBgcICQoLDA0ODxAREhMUFRYX",
    "plaintext": "{\"path\":\"/api/system/pulse\",\"method\":\"GET\"}",
    "ciphertextBase64": "<FILL IN: produced by the first passing Agent box.test run, then frozen>"
}
```

> The `ciphertextBase64` is filled in once (run the Agent box test, copy the produced value, freeze
> it). After that, BOTH suites assert their `seal` output equals this and their `open` recovers the
> plaintext — proving wire compatibility.

- [ ] **Step 3: Write the Agent `envelope.ts` (re-export — codec is defined in the contract, Task 0)**

> The `E2eEnvelope` codec lives in `contract/e2e-envelope.ts` (Task 0). The Agent file just re-exports
> it so the shim/relay (Task 10) keep their `@app/dev-dashboard/lib/e2e/envelope` import path.

```typescript
export { decodeEnvelope, encodeEnvelope, type E2eEnvelope } from "@app/dev-dashboard/contract/e2e-envelope";
```

- [ ] **Step 4: Write the Agent `box.ts` (full code — `nacl` impl + disk keys; types from the contract)**

> `BoxCipher`/`KeyPair` are defined in `contract/box-types.ts` (Task 0); imported here, not redefined.
> This file owns the per-platform `nacl` IMPL + the on-disk keypair (which uses `node:fs`/`Bun` and so
> stays in `lib/*`).

```typescript
import { chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import nacl from "tweetnacl";
import naclUtil from "tweetnacl-util";
import type { BoxCipher, KeyPair } from "@app/dev-dashboard/contract/box-types";

export type { BoxCipher, KeyPair } from "@app/dev-dashboard/contract/box-types";

export const naclBoxCipher: BoxCipher = {
    seal: ({ plaintext, nonce, recipientPublicKey, senderSecretKey }) => nacl.box(plaintext, nonce, recipientPublicKey, senderSecretKey),
    open: ({ ciphertext, nonce, senderPublicKey, recipientSecretKey }) => nacl.box.open(ciphertext, nonce, senderPublicKey, recipientSecretKey),
    randomNonce: () => nacl.randomBytes(nacl.box.nonceLength),
    keyPair: () => {
        const kp = nacl.box.keyPair();
        return { publicKey: kp.publicKey, secretKey: kp.secretKey };
    },
};

export const toBase64 = naclUtil.encodeBase64;
export const fromBase64 = naclUtil.decodeBase64;

const KEY_PATH = join(homedir(), ".genesis-tools", "dev-dashboard", "e2e-keys.json");

interface StoredKeys {
    publicKey: string;
    secretKey: string;
}

/** Loads the Agent's long-term X25519 keypair, generating + persisting it (0600) on first use. */
export async function loadOrCreateAgentKeys(cipher: BoxCipher = naclBoxCipher): Promise<KeyPair> {
    const file = Bun.file(KEY_PATH);

    if (await file.exists()) {
        const stored = SafeJSON.parse(await file.text(), { strict: true }) as StoredKeys;
        return { publicKey: fromBase64(stored.publicKey), secretKey: fromBase64(stored.secretKey) };
    }

    const kp = cipher.keyPair();
    await Bun.write(KEY_PATH, SafeJSON.stringify({ publicKey: toBase64(kp.publicKey), secretKey: toBase64(kp.secretKey) } satisfies StoredKeys));
    chmodSync(KEY_PATH, 0o600);
    logger.info({ path: KEY_PATH }, "dev-dashboard: generated Agent E2E keypair (0600)");

    return kp;
}
```

- [ ] **Step 5: Write the Agent box test (produces the frozen ciphertext) and run it**

```typescript
import { describe, expect, it } from "bun:test";
import { fromBase64, naclBoxCipher, toBase64 } from "@app/dev-dashboard/lib/e2e/box";
import vectors from "@app/dev-dashboard/lib/e2e/test-vectors.json";

describe("naclBoxCipher", () => {
    it("seal then open round-trips", () => {
        const nonce = naclBoxCipher.randomNonce();
        const alice = naclBoxCipher.keyPair();
        const bob = naclBoxCipher.keyPair();
        const msg = new TextEncoder().encode("hello e2e");
        const ct = naclBoxCipher.seal({ plaintext: msg, nonce, recipientPublicKey: bob.publicKey, senderSecretKey: alice.secretKey });
        const opened = naclBoxCipher.open({ ciphertext: ct, nonce, senderPublicKey: alice.publicKey, recipientSecretKey: bob.secretKey });
        expect(opened).not.toBeNull();
        expect(new TextDecoder().decode(opened!)).toBe("hello e2e");
    });

    it("matches the shared test vector (wire compatibility with mobile)", () => {
        const ct = naclBoxCipher.seal({
            plaintext: new TextEncoder().encode(vectors.plaintext),
            nonce: fromBase64(vectors.nonce),
            recipientPublicKey: fromBase64(vectors.bobPublicKey),
            senderSecretKey: fromBase64(vectors.alicePrivateKey),
        });
        // First run: copy toBase64(ct) into vectors.ciphertextBase64, then this assertion locks it.
        expect(toBase64(ct)).toBe(vectors.ciphertextBase64);
    });

    it("open returns null on a tampered ciphertext", () => {
        const ct = fromBase64(vectors.ciphertextBase64);
        ct[0] ^= 0xff;
        const opened = naclBoxCipher.open({
            ciphertext: ct,
            nonce: fromBase64(vectors.nonce),
            senderPublicKey: fromBase64(vectors.alicePublicKey),
            recipientSecretKey: fromBase64(vectors.bobPrivateKey),
        });
        expect(opened).toBeNull();
    });
});
```

Run: `bun test src/dev-dashboard/lib/e2e/box.test.ts`
Expected: FIRST run — the vector assertion fails; copy the printed `toBase64(ct)` into
`test-vectors.json`'s `ciphertextBase64`, re-run → PASS (3 tests). The envelope test:

```typescript
import { describe, expect, it } from "bun:test";
import { decodeEnvelope, encodeEnvelope } from "@app/dev-dashboard/lib/e2e/envelope";

describe("E2eEnvelope codec", () => {
    it("round-trips", () => {
        const env = { v: 1 as const, epk: "a", n: "b", ct: "c" };
        expect(decodeEnvelope(encodeEnvelope(env))).toEqual(env);
    });

    it("throws on a bad version", () => {
        expect(() => decodeEnvelope('{"v":2,"epk":"a","n":"b","ct":"c"}')).toThrow(/invalid/);
    });
});
```

Run: `bun test src/dev-dashboard/lib/e2e/envelope.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Mirror on mobile (`e2e/box-cipher.ts` + `e2e/envelope.ts`) — same vectors**

`DevDashboard/mobile/src/transport/e2e/box-cipher.ts`:

```typescript
import * as SecureStore from "expo-secure-store";
import nacl from "tweetnacl";
import naclUtil from "tweetnacl-util";
import type { BoxCipher, KeyPair } from "@app/dev-dashboard/contract";

export const naclBoxCipher: BoxCipher = {
    seal: ({ plaintext, nonce, recipientPublicKey, senderSecretKey }) => nacl.box(plaintext, nonce, recipientPublicKey, senderSecretKey),
    open: ({ ciphertext, nonce, senderPublicKey, recipientSecretKey }) => nacl.box.open(ciphertext, nonce, senderPublicKey, recipientSecretKey),
    randomNonce: () => nacl.randomBytes(nacl.box.nonceLength),
    keyPair: () => {
        const kp = nacl.box.keyPair();
        return { publicKey: kp.publicKey, secretKey: kp.secretKey };
    },
};

export const toBase64 = naclUtil.encodeBase64;
export const fromBase64 = naclUtil.decodeBase64;

const SECRET_KEY_ITEM = "dd_e2e_secret_key";
const PUBLIC_KEY_ITEM = "dd_e2e_public_key";

/** Loads the device's X25519 keypair from the Secure Enclave/Keystore, generating it on first use.
 *  The PRIVATE key never leaves SecureStore. The vendor never sees it (key-custody invariant). */
export async function loadOrCreateDeviceKeys(cipher: BoxCipher = naclBoxCipher): Promise<KeyPair> {
    const storedSecret = await SecureStore.getItemAsync(SECRET_KEY_ITEM);
    const storedPublic = await SecureStore.getItemAsync(PUBLIC_KEY_ITEM);

    if (storedSecret && storedPublic) {
        return { publicKey: fromBase64(storedPublic), secretKey: fromBase64(storedSecret) };
    }

    const kp = cipher.keyPair();
    await SecureStore.setItemAsync(SECRET_KEY_ITEM, toBase64(kp.secretKey), { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
    await SecureStore.setItemAsync(PUBLIC_KEY_ITEM, toBase64(kp.publicKey));

    return kp;
}
```

`DevDashboard/mobile/src/transport/e2e/envelope.ts` re-exports the codec from the RN-safe contract
package (the codec is relocated there in Task 0 so mobile never value-imports `lib/*`):

```typescript
export { decodeEnvelope, encodeEnvelope, type E2eEnvelope } from "@app/dev-dashboard/contract";
```

Mobile box test (reads the SAME `test-vectors.json` via the workspace import) asserts `seal` produces
`vectors.ciphertextBase64` — proving the phone and Mac codecs are byte-identical:

```typescript
import { describe, expect, it } from "@jest/globals";
import { fromBase64, naclBoxCipher, toBase64 } from "../src/transport/e2e/box-cipher";
import vectors from "@app/dev-dashboard/lib/e2e/test-vectors.json";

describe("mobile naclBoxCipher wire-compat", () => {
    it("produces the shared ciphertext vector (matches Agent)", () => {
        const ct = naclBoxCipher.seal({
            plaintext: new TextEncoder().encode(vectors.plaintext),
            nonce: fromBase64(vectors.nonce),
            recipientPublicKey: fromBase64(vectors.bobPublicKey),
            senderSecretKey: fromBase64(vectors.alicePrivateKey),
        });
        expect(toBase64(ct)).toBe(vectors.ciphertextBase64);
    });
});
```

Run: `cd DevDashboard/mobile && bun run test src/transport/e2e/box-cipher.test.ts`
Expected: PASS — the mobile ciphertext EQUALS the Agent-frozen vector (this is the cross-endpoint
compatibility proof the whole tier rests on).

- [ ] **Step 7: Commit**

```bash
git add src/dev-dashboard/lib/e2e/ DevDashboard/mobile/src/transport/e2e/ DevDashboard/mobile/package.json
git commit -m "feat(dd-e2e): BoxCipher + E2eEnvelope codec, Agent+Mobile, locked by shared vectors"
```

---

### Task 10: E2E pairing + Agent request shim (key custody, no vendor escrow)

> The pairing handshake exchanges ONLY public keys: the Agent's pubkey travels in the managed pairing
> QR (`pk` field, Task 8 `PairingPayload.agentPublicKey`); the phone's pubkey is POSTed to a new
> Agent endpoint `/api/e2e/pair` (over the relay, which sees only the pubkey — public by definition).
> After that, every managed-tier request body is an `E2eEnvelope`; the **e2e-shim** decrypts it,
> runs the existing route registry, and re-encrypts the result. The vendor relay forwards opaque
> ciphertext. **No private key is ever transmitted; the vendor never escrows keys** (the invariant
> that makes the no-see claim honest).

**Files:**
- Create: `src/dev-dashboard/server/transport/e2e-shim.ts` (+ test)
- Create: `src/dev-dashboard/server/routes/e2e.ts` — the `/api/e2e/pair` registrar.
- Modify: `src/dev-dashboard/server/registry.ts` (add `e2eRoutes()`), `src/dev-dashboard/server/serve.ts` (mount the shim when `e2e` is on).

- [ ] **Step 1: Write the failing shim test (decrypt -> handle -> encrypt round-trip)**

```typescript
import { describe, expect, it } from "bun:test";
import { fromBase64, naclBoxCipher, toBase64 } from "@app/dev-dashboard/lib/e2e/box";
import { encodeEnvelope } from "@app/dev-dashboard/lib/e2e/envelope";
import { createE2eShim } from "@app/dev-dashboard/server/transport/e2e-shim";

describe("createE2eShim", () => {
    it("decrypts a request, runs the handler, and returns an encrypted envelope", async () => {
        const agent = naclBoxCipher.keyPair();
        const phone = naclBoxCipher.keyPair();

        const shim = createE2eShim({
            cipher: naclBoxCipher,
            agentKeys: agent,
            resolvePeerKey: () => phone.publicKey,
            // fake the inner registry: echoes the decrypted path back as JSON
            handle: async (plaintext) => new TextEncoder().encode(JSON.stringify({ echoed: new TextDecoder().decode(plaintext) })),
        });

        const nonce = naclBoxCipher.randomNonce();
        const reqCt = naclBoxCipher.seal({
            plaintext: new TextEncoder().encode("GET /api/system/pulse"),
            nonce,
            recipientPublicKey: agent.publicKey,
            senderSecretKey: phone.secretKey,
        });
        const reqEnvelope = encodeEnvelope({ v: 1, epk: toBase64(phone.publicKey), n: toBase64(nonce), ct: toBase64(reqCt) });

        const resEnvelope = await shim.handleEncrypted(reqEnvelope);
        // the phone decrypts the response with the agent pubkey
        const parsed = JSON.parse(resEnvelope);
        const plain = naclBoxCipher.open({
            ciphertext: fromBase64(parsed.ct),
            nonce: fromBase64(parsed.n),
            senderPublicKey: agent.publicKey,
            recipientSecretKey: phone.secretKey,
        });
        expect(JSON.parse(new TextDecoder().decode(plain!))).toEqual({ echoed: "GET /api/system/pulse" });
    });

    it("rejects an envelope it cannot decrypt", async () => {
        const agent = naclBoxCipher.keyPair();
        const shim = createE2eShim({ cipher: naclBoxCipher, agentKeys: agent, resolvePeerKey: () => agent.publicKey, handle: async () => new Uint8Array() });
        await expect(shim.handleEncrypted('{"v":1,"epk":"AA==","n":"AA==","ct":"AA=="}')).rejects.toThrow();
    });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `bun test src/dev-dashboard/server/transport/e2e-shim.test.ts`
Expected: FAIL — `createE2eShim` not defined.

- [ ] **Step 3: Implement `e2e-shim.ts` (full code)**

```typescript
import type { BoxCipher, KeyPair } from "@app/dev-dashboard/lib/e2e/box";
import { fromBase64, toBase64 } from "@app/dev-dashboard/lib/e2e/box";
import { decodeEnvelope, encodeEnvelope } from "@app/dev-dashboard/lib/e2e/envelope";

export interface E2eShimOptions {
    cipher: BoxCipher;
    agentKeys: KeyPair;
    /** Resolves the paired phone's public key (from the pairing store). */
    resolvePeerKey: (peerPublicKeyB64: string) => Uint8Array | null;
    /** Runs the decrypted request through the real route registry; returns the plaintext result bytes. */
    handle: (plaintext: Uint8Array) => Promise<Uint8Array>;
}

export interface E2eShim {
    /** Decrypt an inbound envelope, run the handler, return an encrypted response envelope. */
    handleEncrypted(rawEnvelope: string): Promise<string>;
}

export function createE2eShim(opts: E2eShimOptions): E2eShim {
    return {
        async handleEncrypted(rawEnvelope: string): Promise<string> {
            const env = decodeEnvelope(rawEnvelope);
            const peerKey = opts.resolvePeerKey(env.epk);

            if (!peerKey) {
                throw new Error("e2e: unknown peer public key (not paired)");
            }

            const plaintext = opts.cipher.open({
                ciphertext: fromBase64(env.ct),
                nonce: fromBase64(env.n),
                senderPublicKey: peerKey,
                recipientSecretKey: opts.agentKeys.secretKey,
            });

            if (!plaintext) {
                throw new Error("e2e: request decryption failed (auth tag mismatch)");
            }

            const resultBytes = await opts.handle(plaintext);
            const nonce = opts.cipher.randomNonce();
            const ct = opts.cipher.seal({
                plaintext: resultBytes,
                nonce,
                recipientPublicKey: peerKey,
                senderSecretKey: opts.agentKeys.secretKey,
            });

            return encodeEnvelope({ v: 1, epk: toBase64(opts.agentKeys.publicKey), n: toBase64(nonce), ct: toBase64(ct) });
        },
    };
}
```

- [ ] **Step 4: Implement the `/api/e2e/pair` registrar (`routes/e2e.ts`)**

> Stores the phone's PUBLIC key (only). The pairing store is a 0600 JSON file; it holds public keys
> only — there is nothing here the vendor could misuse even if the relay logged it.

```typescript
import { chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import type { RouteDef } from "@app/dev-dashboard/server/types";

const PEERS_PATH = join(homedir(), ".genesis-tools", "dev-dashboard", "e2e-peers.json");

interface PeerRecord {
    publicKey: string;
    pairedAt: string;
}

export async function loadPeers(): Promise<Record<string, PeerRecord>> {
    const file = Bun.file(PEERS_PATH);

    if (!(await file.exists())) {
        return {};
    }

    return SafeJSON.parse(await file.text(), { strict: true }) as Record<string, PeerRecord>;
}

async function addPeer(publicKeyB64: string): Promise<void> {
    const peers = await loadPeers();
    peers[publicKeyB64] = { publicKey: publicKeyB64, pairedAt: new Date().toISOString() };
    await Bun.write(PEERS_PATH, SafeJSON.stringify(peers, null, 2));
    chmodSync(PEERS_PATH, 0o600);
}

export function e2eRoutes(): RouteDef[] {
    return [
        {
            method: "POST",
            pattern: "/api/e2e/pair",
            handler: async (ctx) => {
                const body = await ctx.readJson<{ publicKey?: string; deviceCode?: string }>();

                if (!body.publicKey) {
                    return { kind: "json", status: 400, body: { error: "publicKey required" } };
                }

                // deviceCode would be verified against a short-lived code shown on the Mac during
                // `tunnel setup --managed`; for the self-pair path the QR already authenticated.
                await addPeer(body.publicKey);

                return { kind: "json", status: 200, body: { ok: true } };
            },
        },
    ];
}
```

- [ ] **Step 5: Wire into registry + serve, run tests**

In `registry.ts` add `...e2eRoutes()` to `createDashboardRouter()` and add `"POST /api/e2e/pair"` to
the `EXPECTED` array in `registry.test.ts`.

In `serve.ts`, when `opts.e2e` is enabled, intercept managed-tier requests (a header `x-dd-e2e: 1`)
before the router: read the body as an `E2eEnvelope`, route it through `createE2eShim({ handle: (pt) =>
runDecryptedThroughRouter(pt) })`, and return the response envelope. Pairing (`/api/e2e/pair`) and the
liveness probe stay plaintext (they carry only public data).

Run: `bun test src/dev-dashboard/server/transport/e2e-shim.test.ts ; bun test src/dev-dashboard/server/registry.test.ts`
Expected: PASS (shim 2 tests; registry includes the pair route).

- [ ] **Step 6: Commit**

```bash
git add src/dev-dashboard/server/transport/e2e-shim.ts src/dev-dashboard/server/routes/e2e.ts src/dev-dashboard/server/registry.ts src/dev-dashboard/server/registry.test.ts src/dev-dashboard/server/serve.ts
git commit -m "feat(dd-e2e): Agent pairing endpoint (public keys only) + request decrypt/encrypt shim"
```

---

### Task 11: `E2eTransport` decorator + managed tier (mobile)

> The decorator wraps a relay `PlainTransport`: it intercepts the client's fetch + SSE + WS frames,
> encrypts each payload to the Agent's pubkey, and decrypts responses with the device secret key.
> The relay sees only `E2eEnvelope` ciphertext. This is the only tier where the no-see claim depends
> on this layer (ADR §4 — the marketing copy must say so).

**Files:**
- Create: `DevDashboard/mobile/src/transport/e2e-transport.ts`
- Create: `DevDashboard/mobile/src/transport/tiers/managed.ts` (+ test)

- [ ] **Step 1: Write the failing managed-tier test (loopback through the REAL Agent shim)**

> The fake "relay" `fetch` pipes the request envelope straight into the real `createE2eShim` (the
> server crypto), so the decorator is verified against the actual Agent code, not a mock. This is the
> cross-stack proof: a request the phone encrypts is decrypted + handled + re-encrypted by the Agent,
> then decrypted back by the phone.

```typescript
import { describe, expect, it } from "@jest/globals";
import { naclBoxCipher } from "../src/transport/e2e/box-cipher";
import { createE2eTransport } from "../src/transport/e2e-transport";
import { createE2eShim } from "@app/dev-dashboard/server/transport/e2e-shim";

describe("createE2eTransport", () => {
    it("encrypts an outbound request and decrypts the agent's response (real shim loopback)", async () => {
        const agent = naclBoxCipher.keyPair();
        const device = naclBoxCipher.keyPair();

        const shim = createE2eShim({
            cipher: naclBoxCipher,
            agentKeys: agent,
            resolvePeerKey: () => device.publicKey,
            // the "server": echo the decrypted request line back as JSON
            handle: async (plaintext) => new TextEncoder().encode(JSON.stringify({ echoed: new TextDecoder().decode(plaintext) })),
        });

        // The relay just forwards the request envelope to the shim and returns the response envelope.
        const relayFetch = (async (_url: string, init?: RequestInit) => {
            const responseEnvelope = await shim.handleEncrypted(String(init?.body));
            return new Response(responseEnvelope, { status: 200 });
        }) as unknown as typeof fetch;

        const t = createE2eTransport({
            relayBaseUrl: "https://relay.vendor.com/agent/abc",
            cipher: naclBoxCipher,
            deviceKeys: device,
            agentPublicKey: agent.publicKey,
            fetchImpl: relayFetch,
        });

        expect(t.tier).toBe("managed");
        expect(t.baseUrl()).toBe("https://relay.vendor.com/agent/abc");

        // GET /api/system/pulse over the encrypting client -> the shim echoes the request line back.
        const pulse = await t.client().system.pulse();
        expect((pulse as unknown as { echoed: string }).echoed).toBe("GET /api/system/pulse\n\n");
    });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `cd DevDashboard/mobile && bun run test src/transport/tiers/managed.test.ts`
Expected: FAIL — `createE2eTransport` not defined.

- [ ] **Step 3: Implement `e2e-transport.ts` (full code)**

```typescript
import { createDashboardClient, decodeEnvelope, encodeEnvelope, type BoxCipher, type DashboardClient, type KeyPair } from "@app/dev-dashboard/contract";
import { fromBase64, toBase64 } from "./e2e/box-cipher";
import { createQaStream } from "./qa-stream";
import { streamSse as defaultStreamSse, type SseEvent } from "./sse-parser";
import { createTerminalTransport } from "./terminal-ws";
import type { QaStream, TerminalTransport, Transport } from "./Transport";

export interface E2eTransportOptions {
    /** The vendor relay base URL for this paired Agent (opaque to the vendor). */
    relayBaseUrl: string;
    cipher: BoxCipher;
    deviceKeys: KeyPair;
    agentPublicKey: Uint8Array;
    /** expo/fetch by default; tests inject a loopback to the Agent shim. */
    fetchImpl?: typeof fetch;
    probe?: () => Promise<boolean>;
}

export function createE2eTransport(opts: E2eTransportOptions): Transport {
    const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);

    /** Encrypt a request line ("METHOD path\n\nbody") -> envelope; POST to the relay; decrypt the response. */
    async function encryptedExchange(plaintext: Uint8Array): Promise<Uint8Array> {
        const nonce = opts.cipher.randomNonce();
        const ct = opts.cipher.seal({ plaintext, nonce, recipientPublicKey: opts.agentPublicKey, senderSecretKey: opts.deviceKeys.secretKey });
        const reqEnvelope = encodeEnvelope({ v: 1, epk: toBase64(opts.deviceKeys.publicKey), n: toBase64(nonce), ct: toBase64(ct) });

        const res = await fetchImpl(`${opts.relayBaseUrl}/api/e2e/exchange`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-dd-e2e": "1" },
            body: reqEnvelope,
        });

        const env = decodeEnvelope(await res.text());
        const plain = opts.cipher.open({
            ciphertext: fromBase64(env.ct),
            nonce: fromBase64(env.n),
            senderPublicKey: opts.agentPublicKey,
            recipientSecretKey: opts.deviceKeys.secretKey,
        });

        if (!plain) {
            throw new Error("e2e: response decryption failed");
        }

        return plain;
    }

    /** A `fetch`-shaped wrapper that the contract client can use, but every byte is E2E-encrypted. */
    const encryptingFetch = (async (url: string, init?: RequestInit): Promise<Response> => {
        const path = url.replace(opts.relayBaseUrl, "");
        const line = `${init?.method ?? "GET"} ${path}\n\n${init?.body ? String(init.body) : ""}`;
        const plain = await encryptedExchange(new TextEncoder().encode(line));

        return new Response(plain, { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    function client(): DashboardClient {
        return createDashboardClient({ baseUrl: opts.relayBaseUrl, fetch: encryptingFetch, authHeader: () => undefined });
    }

    return {
        tier: "managed",
        baseUrl: () => opts.relayBaseUrl,
        authHeader: () => undefined,
        reachable: opts.probe ?? (async () => {
            try {
                await encryptedExchange(new TextEncoder().encode("GET /api/system/pulse\n\n"));
                return true;
            } catch {
                return false;
            }
        }),
        client,
        streamQa(): QaStream {
            // Each relayed SSE `data:` line is an E2eEnvelope. The decrypting streamSse opens each
            // envelope to the plaintext QaEntry JSON and re-emits it as a normal SseEvent, so the
            // QaStream's own parser/dedupe (Task 3) is unchanged. Mirror of wrapTerminalE2e on send.
            const decryptingStreamSse: typeof defaultStreamSse = (sseOpts) =>
                defaultStreamSse({
                    ...sseOpts,
                    onEvent: (event: SseEvent) => {
                        try {
                            const env = decodeEnvelope(event.data);
                            const plain = opts.cipher.open({
                                ciphertext: fromBase64(env.ct),
                                nonce: fromBase64(env.n),
                                senderPublicKey: opts.agentPublicKey,
                                recipientSecretKey: opts.deviceKeys.secretKey,
                            });

                            if (plain) {
                                sseOpts.onEvent({ ...event, data: new TextDecoder().decode(plain) });
                            }
                        } catch {
                            // drop a frame that isn't a valid envelope (keep-alive / handshake noise)
                        }
                    },
                });

            return createQaStream({
                baseUrl: opts.relayBaseUrl,
                authHeader: () => undefined,
                streamSseImpl: decryptingStreamSse,
            });
        },
        openTerminal(sessionId: string): TerminalTransport {
            // ttyd frames are E2E-wrapped at the relay; the renderer sends/receives plaintext via a
            // decrypting message adapter. partysocket carries ciphertext envelopes; we seal on send
            // and open on message.
            const wsUrl = `${opts.relayBaseUrl.replace(/^http/, "ws")}/ttyd/${sessionId}/ws`;
            const inner = createTerminalTransport({ wsUrl });
            return wrapTerminalE2e(inner, opts);
        },
    };
}

/** Wraps a TerminalTransport so send() seals and onMessage() opens E2eEnvelopes. */
function wrapTerminalE2e(inner: TerminalTransport, opts: E2eTransportOptions): TerminalTransport {
    return {
        get status() {
            return inner.status;
        },
        send(data) {
            const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data as ArrayBuffer);
            const nonce = opts.cipher.randomNonce();
            const ct = opts.cipher.seal({ plaintext: bytes, nonce, recipientPublicKey: opts.agentPublicKey, senderSecretKey: opts.deviceKeys.secretKey });
            inner.send(encodeEnvelope({ v: 1, epk: toBase64(opts.deviceKeys.publicKey), n: toBase64(nonce), ct: toBase64(ct) }));
        },
        onMessage(handler) {
            inner.onMessage((raw) => {
                try {
                    const env = decodeEnvelope(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
                    const plain = opts.cipher.open({
                        ciphertext: fromBase64(env.ct),
                        nonce: fromBase64(env.n),
                        senderPublicKey: opts.agentPublicKey,
                        recipientSecretKey: opts.deviceKeys.secretKey,
                    });

                    if (plain) {
                        handler(new TextDecoder().decode(plain));
                    }
                } catch {
                    // drop a frame that isn't a valid envelope (keep-alive / handshake noise)
                }
            });
        },
        onStatus: (handler) => inner.onStatus(handler),
        close: () => inner.close(),
    };
}
```

- [ ] **Step 4: Implement the managed tier (`tiers/managed.ts`)**

```typescript
import { loadOrCreateDeviceKeys, naclBoxCipher } from "../e2e/box-cipher";
import { fromBase64 } from "../e2e/box-cipher";
import { createE2eTransport } from "../e2e-transport";
import type { PairingPayload } from "@app/dev-dashboard/contract";
import type { Transport } from "../Transport";

/** Builds the managed (vendor-relay) Transport. agentPublicKey came from the pairing QR (`pk`). */
export async function createManagedTransport(pairing: PairingPayload): Promise<Transport> {
    if (!pairing.agentPublicKey) {
        throw new Error("managed tier requires the Agent public key from the pairing QR");
    }

    const deviceKeys = await loadOrCreateDeviceKeys();

    return createE2eTransport({
        relayBaseUrl: pairing.baseUrl,
        cipher: naclBoxCipher,
        deviceKeys,
        agentPublicKey: fromBase64(pairing.agentPublicKey),
    });
}
```

- [ ] **Step 5: Run the managed test (against the real Agent shim as loopback) + commit**

Run: `cd DevDashboard/mobile && bun run test src/transport/tiers/managed.test.ts`
Expected: PASS — a request encrypted by the decorator is decrypted by the real `createE2eShim`, run,
and the response is decrypted back by the decorator (cross-stack crypto proof).

```bash
git add DevDashboard/mobile/src/transport/e2e-transport.ts DevDashboard/mobile/src/transport/tiers/managed.ts DevDashboard/mobile/src/transport/tiers/managed.test.ts
git commit -m "feat(dd-mobile): E2eTransport decorator + managed tier (vendor relay sees only ciphertext)"
```

---

### Task 12: Connection store + QR parsing + factory (Zustand)

> The store owns the active tier, persisted endpoints, and (via SecureStore) creds + pairing keys.
> Prefs persist via `expo-sqlite/kv-store` (ADR §6); secrets via `expo-secure-store`. A `buildTransport`
> factory turns the persisted connection into a concrete `Transport` (Tasks 6/7/8/11).

**Files:**
- Create: `DevDashboard/mobile/src/lib/qr.ts` (+ test)
- Create: `DevDashboard/mobile/src/state/connection-store.ts`

- [ ] **Step 1: Write the failing qr test**

```typescript
import { describe, expect, it } from "@jest/globals";
import { parseScannedPairing } from "../src/lib/qr";

describe("parseScannedPairing", () => {
    it("accepts a self-cloudflared pairing URI", () => {
        const r = parseScannedPairing("devdashboard://pair?tier=cloudflared-self&baseUrl=https%3A%2F%2Fmac.example.com&username=martin");
        expect(r?.tier).toBe("cloudflared-self");
        expect(r?.baseUrl).toBe("https://mac.example.com");
    });

    it("accepts a managed pairing URI with an agent public key", () => {
        const r = parseScannedPairing("devdashboard://pair?tier=managed&baseUrl=https%3A%2F%2Frelay.v.com%2Fa&username=m&pk=AAAA");
        expect(r?.agentPublicKey).toBe("AAAA");
    });

    it("rejects a non-pairing QR (e.g. a random URL)", () => {
        expect(parseScannedPairing("https://google.com")).toBeNull();
    });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `cd DevDashboard/mobile && bun run test src/lib/qr.test.ts`
Expected: FAIL — `parseScannedPairing` not defined.

- [ ] **Step 3: Implement `qr.ts` (full code)**

```typescript
import { parsePairingPayload, type PairingPayload } from "@app/dev-dashboard/contract";

/** Wraps the (RN-safe, contract-hosted) pairing parser; rejects anything that isn't a pairing URI. */
export function parseScannedPairing(scanned: string): PairingPayload | null {
    return parsePairingPayload(scanned.trim());
}
```

- [ ] **Step 4: Run to confirm it passes**

Run: `cd DevDashboard/mobile && bun run test src/lib/qr.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Implement `connection-store.ts` (full code)**

```typescript
import Storage from "expo-sqlite/kv-store";
import * as SecureStore from "expo-secure-store";
import { create } from "zustand";
import { createCloudflaredTransport } from "../transport/tiers/cloudflared";
import { createLanTransport, type LanCredentials } from "../transport/tiers/lan";
import { createManagedTransport } from "../transport/tiers/managed";
import { createTailscaleTransport } from "../transport/tiers/tailscale";
import type { DiscoveredAgent } from "../transport/lan-discovery";
import type { PairingPayload } from "@app/dev-dashboard/contract";
import type { Transport, TransportTier } from "../transport/Transport";

const ACTIVE_TIER_KEY = "dd.activeTier";
const PASSWORD_ITEM = "dd_basic_password";

interface ConnectionState {
    tier: TransportTier | null;
    transport: Transport | null;
    setLan: (agent: DiscoveredAgent, creds: LanCredentials) => Promise<void>;
    setTailscale: (cfg: { tailnetHost: string; port: number; username: string; password: string }) => Promise<void>;
    setCloudflared: (pairing: PairingPayload, password: string) => Promise<void>;
    setManaged: (pairing: PairingPayload) => Promise<void>;
    restore: () => Promise<void>;
}

async function savePassword(password: string): Promise<void> {
    await SecureStore.setItemAsync(PASSWORD_ITEM, password, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
}

export const useConnectionStore = create<ConnectionState>((set) => ({
    tier: null,
    transport: null,
    async setLan(agent, creds) {
        await savePassword(creds.password);
        await Storage.setItem(ACTIVE_TIER_KEY, "lan");
        set({ tier: "lan", transport: createLanTransport(agent, creds) });
    },
    async setTailscale(cfg) {
        await savePassword(cfg.password);
        await Storage.setItem(ACTIVE_TIER_KEY, "tailscale");
        set({ tier: "tailscale", transport: createTailscaleTransport(cfg) });
    },
    async setCloudflared(pairing, password) {
        await savePassword(password);
        await Storage.setItem(ACTIVE_TIER_KEY, "cloudflared-self");
        set({ tier: "cloudflared-self", transport: createCloudflaredTransport(pairing, password) });
    },
    async setManaged(pairing) {
        await Storage.setItem(ACTIVE_TIER_KEY, "managed");
        set({ tier: "managed", transport: await createManagedTransport(pairing) });
    },
    async restore() {
        const tier = (await Storage.getItem(ACTIVE_TIER_KEY)) as TransportTier | null;
        // Endpoint details per tier are persisted alongside (omitted for brevity); the Connect screen
        // re-hydrates them and calls the matching setter. `restore` sets the last tier for the UI.
        set({ tier });
    },
}));
```

- [ ] **Step 6: Typecheck + commit**

Run: `cd DevDashboard/mobile && bunx tsgo --noEmit | rg "lib/qr|state/connection-store"`
Expected: no errors.

```bash
git add DevDashboard/mobile/src/lib/qr.ts DevDashboard/mobile/src/lib/qr.test.ts DevDashboard/mobile/src/state/connection-store.ts
git commit -m "feat(dd-mobile): connection store (Zustand) + pairing-QR parser"
```

---

### Task 13: Connect/Pair screen (tier picker + QR scanner + reachability states)

> The UX surface. Before writing it, invoke the `expo:building-native-ui` skill and read
> `.claude/docs/design-system.md` (per-project UI contract). Every interactive element gets an
> `accessibilityLabel` matching the Appium accessibility-id (Task 14). `expo-camera`'s `CameraView`
> does QR scanning in SDK 55 — note issue #44491: ensure the barcode scanner is NOT opted out in the
> `expo-camera` config plugin (`barcodeScannerEnabled` defaults true).

**Files:**
- Create: `DevDashboard/mobile/app/connect.tsx`
- Create: `DevDashboard/mobile/src/components/connect/TierPicker.tsx`
- Create: `DevDashboard/mobile/src/components/connect/QrScanner.tsx`
- Create: `DevDashboard/mobile/src/components/connect/ReachabilityBadge.tsx`
- Modify: `DevDashboard/mobile/app.config.ts` (camera perms + plugin)

- [ ] **Step 1: Install expo-camera + add perms**

Run: `cd DevDashboard/mobile && npx expo install expo-camera`
Add to `app.config.ts`:

```typescript
ios: { infoPlist: { NSCameraUsageDescription: "Scan the pairing QR shown by the DevDashboard agent." } },
android: { permissions: ["android.permission.CAMERA"] },
plugins: [
    ["expo-camera", { cameraPermission: "Scan the pairing QR shown by the DevDashboard agent." }],
],
```

- [ ] **Step 2: Implement `ReachabilityBadge.tsx` (full code)**

```typescript
import { Text, View } from "react-native";
import type { ReachState } from "../../transport/reachability";

const LABELS: Record<ReachState["kind"], string> = {
    idle: "Not connected",
    probing: "Checking…",
    reachable: "Connected",
    unreachable: "Unreachable",
    "needs-vpn": "Turn on Tailscale",
    "needs-pair": "Pair this device",
};

export function ReachabilityBadge({ state }: { state: ReachState }) {
    return (
        <View accessibilityLabel="reachability-badge" accessibilityRole="text">
            <Text accessibilityLabel={`reachability-${state.kind}`}>{LABELS[state.kind]}</Text>
        </View>
    );
}
```

- [ ] **Step 3: Implement `QrScanner.tsx` (full code)**

```typescript
import { CameraView, useCameraPermissions } from "expo-camera";
import { useState } from "react";
import { Button, Text, View } from "react-native";

export function QrScanner({ onScanned }: { onScanned: (data: string) => void }) {
    const [permission, requestPermission] = useCameraPermissions();
    const [scannedOnce, setScannedOnce] = useState(false);

    if (!permission) {
        return <Text accessibilityLabel="qr-scanner-loading">Loading camera…</Text>;
    }

    if (!permission.granted) {
        return (
            <View accessibilityLabel="qr-scanner-permission">
                <Text>Camera access is needed to scan the pairing QR.</Text>
                <Button title="Grant camera access" onPress={requestPermission} />
            </View>
        );
    }

    return (
        <CameraView
            accessibilityLabel="qr-scanner-camera"
            style={{ flex: 1 }}
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={({ data }) => {
                if (scannedOnce) {
                    return;
                }

                setScannedOnce(true);
                onScanned(data);
            }}
        />
    );
}
```

- [ ] **Step 4: Implement `TierPicker.tsx` (full code)**

```typescript
import { Pressable, Text, View } from "react-native";
import type { TransportTier } from "../../transport/Transport";

const TIERS: Array<{ tier: TransportTier; title: string; subtitle: string }> = [
    { tier: "lan", title: "Same Wi-Fi (LAN)", subtitle: "Direct, nothing leaves your network" },
    { tier: "tailscale", title: "Tailscale (trust-max)", subtitle: "Encrypted end-to-end over WireGuard" },
    { tier: "cloudflared-self", title: "My Cloudflare tunnel", subtitle: "Your own account — vendor never sees data" },
    { tier: "managed", title: "Managed (one-tap)", subtitle: "Vendor relay, end-to-end encrypted on top" },
];

export function TierPicker({ selected, onSelect }: { selected: TransportTier | null; onSelect: (t: TransportTier) => void }) {
    return (
        <View accessibilityLabel="tier-picker">
            {TIERS.map((t) => (
                <Pressable
                    key={t.tier}
                    accessibilityLabel={`tier-option-${t.tier}`}
                    accessibilityState={{ selected: selected === t.tier }}
                    onPress={() => onSelect(t.tier)}
                >
                    <Text accessibilityLabel={`tier-title-${t.tier}`}>{t.title}</Text>
                    <Text>{t.subtitle}</Text>
                </Pressable>
            ))}
        </View>
    );
}
```

- [ ] **Step 5: Implement `app/connect.tsx` (full code)**

```typescript
import { useReducer, useState } from "react";
import { Button, ScrollView, Text, View } from "react-native";
import { router } from "expo-router";
import { QrScanner } from "../src/components/connect/QrScanner";
import { ReachabilityBadge } from "../src/components/connect/ReachabilityBadge";
import { TierPicker } from "../src/components/connect/TierPicker";
import { useZeroconfDiscovery } from "../src/transport/lan-discovery";
import { reachabilityReducer } from "../src/transport/reachability";
import { openTailscaleApp } from "../src/transport/tiers/tailscale";
import { parseScannedPairing } from "../src/lib/qr";
import { useConnectionStore } from "../src/state/connection-store";
import type { TransportTier } from "../src/transport/Transport";

export default function ConnectScreen() {
    const [tier, setTier] = useState<TransportTier | null>(null);
    const [reach, dispatchReach] = useReducer(reachabilityReducer, { kind: "idle" });
    const { agents, scanning, rescan } = useZeroconfDiscovery();
    const { setLan, setCloudflared, setManaged, transport } = useConnectionStore();

    async function probe(): Promise<void> {
        if (!transport) {
            return;
        }

        dispatchReach({ type: "probe-start" });
        const ok = await transport.reachable();
        dispatchReach(ok ? { type: "probe-ok" } : { type: "probe-fail", tier: transport.tier, paired: transport.tier !== "managed" });
    }

    async function onQrScanned(data: string): Promise<void> {
        const pairing = parseScannedPairing(data);

        if (!pairing) {
            return;
        }

        if (pairing.tier === "managed") {
            await setManaged(pairing);
        } else {
            await setCloudflared(pairing, ""); // password collected separately for self-cloudflared
        }

        await probe();
    }

    return (
        <ScrollView accessibilityLabel="connect-screen" contentContainerStyle={{ padding: 16 }}>
            <Text accessibilityLabel="connect-title">Connect to your Mac</Text>
            <TierPicker selected={tier} onSelect={setTier} />
            <ReachabilityBadge state={reach} />

            {tier === "lan" ? (
                <View accessibilityLabel="lan-agent-list">
                    {scanning ? <Text accessibilityLabel="lan-scanning">Scanning…</Text> : null}
                    {agents.map((a) => (
                        <Button
                            key={a.baseUrl}
                            title={`${a.name} (${a.host})`}
                            accessibilityLabel={`lan-agent-${a.host}`}
                            onPress={async () => {
                                await setLan(a, { username: "martin", password: "" }); // password prompt in plan 04
                                await probe();
                            }}
                        />
                    ))}
                    <Button title="Rescan" accessibilityLabel="lan-rescan" onPress={rescan} />
                </View>
            ) : null}

            {tier === "tailscale" ? (
                <View accessibilityLabel="tailscale-panel">
                    <Text>Turn on the Tailscale VPN, then probe reachability.</Text>
                    <Button title="Open Tailscale" accessibilityLabel="open-tailscale" onPress={openTailscaleApp} />
                    <Button title="Check reachability" accessibilityLabel="tailscale-probe" onPress={probe} />
                </View>
            ) : null}

            {tier === "cloudflared-self" || tier === "managed" ? (
                <View accessibilityLabel="pair-panel" style={{ height: 320 }}>
                    <QrScanner onScanned={onQrScanned} />
                </View>
            ) : null}

            {reach.kind === "reachable" ? (
                <Button title="Continue" accessibilityLabel="connect-continue" onPress={() => router.replace("/")} />
            ) : null}
        </ScrollView>
    );
}
```

> Re-style with the design system in plan 04 (this is the functional/a11y skeleton — Appium needs the
> labels above). Keep every `accessibilityLabel` stable; Task 14's Page Object locates by them.

- [ ] **Step 6: Typecheck + commit**

Run: `cd DevDashboard/mobile && bunx tsgo --noEmit | rg "connect|components/connect"`
Expected: no errors.

```bash
git add DevDashboard/mobile/app/connect.tsx DevDashboard/mobile/src/components/connect/ DevDashboard/mobile/app.config.ts
git commit -m "feat(dd-mobile): Connect/Pair screen — tier picker + QR scanner + reachability UI"
```

---

### Task 14: ConnectPage Appium spec + Page Object (the done-gate)

> Per ADR §8, this feature is "done" only when its Appium spec passes on the iOS dev-client. Use the
> `appium` skill (`appium_*` MCP tools); locate by accessibility-id (the `accessibilityLabel`s set in
> Task 13). The spec drives the tier picker, asserts each tier surfaces the right reachability state,
> and exercises the QR-scan path with a mocked scan (inject the pairing URI via a deep link rather
> than presenting a real QR to the simulator camera — the sim has no camera).

**Files:**
- Create: `DevDashboard/mobile/e2e/pages/ConnectPage.page.ts`
- Create: `DevDashboard/mobile/e2e/specs/connect.spec.ts`

- [ ] **Step 1: Implement the Page Object (`ConnectPage.page.ts`)**

```typescript
import type { Browser } from "webdriverio";

/** accessibility-id locator helper (iOS predicate / Android resource-id via ~). */
const byId = (id: string) => `~${id}`;

export class ConnectPage {
    constructor(private readonly driver: Browser) {}

    async isShown(): Promise<boolean> {
        return this.driver.$(byId("connect-screen")).isExisting();
    }

    async selectTier(tier: "lan" | "tailscale" | "cloudflared-self" | "managed"): Promise<void> {
        await this.driver.$(byId(`tier-option-${tier}`)).click();
    }

    async reachabilityLabel(): Promise<string> {
        const el = await this.driver.$(byId("reachability-badge"));
        return el.getText();
    }

    async isReachabilityState(kind: string): Promise<boolean> {
        return this.driver.$(byId(`reachability-${kind}`)).isExisting();
    }

    async tapOpenTailscale(): Promise<void> {
        await this.driver.$(byId("open-tailscale")).click();
    }

    async tapTailscaleProbe(): Promise<void> {
        await this.driver.$(byId("tailscale-probe")).click();
    }

    async isPairPanelShown(): Promise<boolean> {
        return this.driver.$(byId("pair-panel")).isExisting();
    }

    async isLanListShown(): Promise<boolean> {
        return this.driver.$(byId("lan-agent-list")).isExisting();
    }

    /** Simulate a scanned pairing QR by deep-linking the pairing URI into the app. */
    async injectPairing(uri: string): Promise<void> {
        await this.driver.execute("mobile: deepLink", { url: uri, bundleId: "dev.genesistools.devdashboard" });
    }

    async tapContinue(): Promise<void> {
        await this.driver.$(byId("connect-continue")).click();
    }
}
```

- [ ] **Step 2: Implement the spec (`connect.spec.ts`)**

```typescript
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { remote, type Browser } from "webdriverio";
import { ConnectPage } from "../pages/ConnectPage.page";

const CAPS = {
    platformName: "iOS",
    "appium:automationName": "XCUITest",
    "appium:deviceName": "iPhone 16",
    "appium:bundleId": "dev.genesistools.devdashboard",
};

describe("ConnectPage", () => {
    let driver: Browser;
    let page: ConnectPage;

    beforeAll(async () => {
        driver = await remote({ hostname: "127.0.0.1", port: 4723, capabilities: CAPS });
        page = new ConnectPage(driver);
    });

    afterAll(async () => {
        await driver?.deleteSession();
    });

    it("renders the connect screen with all four tiers", async () => {
        expect(await page.isShown()).toBe(true);
        for (const tier of ["lan", "tailscale", "cloudflared-self", "managed"] as const) {
            await page.selectTier(tier);
        }
    });

    it("LAN tier shows the agent discovery list", async () => {
        await page.selectTier("lan");
        expect(await page.isLanListShown()).toBe(true);
    });

    it("Tailscale tier offers the open-app deep link and probes to needs-vpn when the VPN is off", async () => {
        await page.selectTier("tailscale");
        await page.tapTailscaleProbe();
        await driver.waitUntil(async () => page.isReachabilityState("needs-vpn") || page.isReachabilityState("reachable"), {
            timeout: 8000,
        });
        expect(await page.isReachabilityState("needs-vpn") || (await page.isReachabilityState("reachable"))).toBe(true);
    });

    it("self-cloudflared / managed tier shows the QR scanner panel", async () => {
        await page.selectTier("cloudflared-self");
        expect(await page.isPairPanelShown()).toBe(true);
    });

    it("a deep-linked pairing URI pairs and reaches the agent (against a test agent)", async () => {
        await page.selectTier("cloudflared-self");
        await page.injectPairing("devdashboard://pair?tier=cloudflared-self&baseUrl=http%3A%2F%2F127.0.0.1%3A3042&username=martin");
        await driver.waitUntil(async () => page.isReachabilityState("reachable"), { timeout: 10000 });
        await page.tapContinue();
    });
});
```

- [ ] **Step 3: Run the spec on the iOS dev-client (the done-gate)**

Prereqs: a running Appium server (`appium_skills` to verify install), an iOS simulator booted with the
DevDashboard dev-client installed (plan 04 `eas build --profile development` / `expo run:ios`), and a
test Agent on `127.0.0.1:3042` (`tools dev-dashboard agent --port 3042`). Drive via the `appium` skill
(`select_device`, `appium_session_management action=create`, then the Page Object methods which map to
`appium_find_element` / `appium_gesture`).

Run: `cd DevDashboard/mobile && bun run e2e -- e2e/specs/connect.spec.ts` (the e2e script is defined in plan 04)
Expected: all 5 spec cases PASS. **The Transport & Trust feature is "done" only when this spec is green.**

- [ ] **Step 4: Commit**

```bash
git add DevDashboard/mobile/e2e/pages/ConnectPage.page.ts DevDashboard/mobile/e2e/specs/connect.spec.ts
git commit -m "test(dd-mobile): ConnectPage Appium spec + Page Object (transport done-gate)"
```

---

## Self-Review checklist (run after implementing)

1. **Type consistency with the ADR:** the `Transport` interface keeps the ADR §4 members (`tier`,
   `baseUrl()`, `authHeader()`, `reachable()`, `streamQa()`, `openTerminal()`), with two **documented
   refinements** (Task 1 banner): `streamQa()` returns a `QaStream` (whose `.connect(onRow,onStatus)`
   carries the ADR's callbacks + a `close()`/status channel from research file 04) rather than a bare
   `Disposable`, and a `client()` member is added so feature plans get a wired contract client.
   `QaStream`, `TerminalTransport`, `Disposable`, `TransportTier` are the only transport types; no
   accidental divergence. The contract's `createDashboardClient`/`EventSourceLike`/`DashboardClient`
   (plan 03) are imported, never re-declared.
2. **All four tiers behind `Transport`:** LAN (`createLanTransport`), Tailscale
   (`createTailscaleTransport`), self-cloudflared (`createCloudflaredTransport`), managed
   (`createManagedTransport` → `E2eTransport`). Tier selection swaps the impl; no feature code
   branches on tier.
3. **SSE:** `expo/fetch` + the `SseFramer` (multi-line `data:`, comment keep-alives, chunk-boundary
   buffering all unit-tested). `react-native-sse` documented as the swap-in fallback behind `QaStream`.
   Resync = id-dedupe + AppState re-fetch (mirrors the web; no `Last-Event-ID`).
4. **WebSocket:** `partysocket` + ping/pong heartbeat (`heartbeatReducer` unit-tested) + AppState
   teardown/rebuild. Backgrounding kills the socket by design; tmux/cmux hold the session.
5. **Trust honesty (marketing must match architecture):** "we can't see your data" is unconditional
   for LAN, Tailscale, and self-cloudflared (user's own CF account). For managed it is a property of
   the E2E layer ONLY, with the metadata caveat — encoded in `TierPicker` subtitles + the trust copy.
6. **E2E is real, not hand-waved:** X25519 ECDH + `crypto_box` AEAD; shared `test-vectors.json` locks
   the Agent and Mobile codecs to the same wire bytes; the managed-tier test round-trips through the
   REAL `createE2eShim`. **Key custody:** private keys live only in `expo-secure-store` (phone) and a
   0600 key file (Mac); pairing exchanges public keys only; the vendor never escrows a private key.
7. **Library choice surfaced (ADR §0 rule 2):** the PROPOSED `tweetnacl` (+ `react-native-libsodium`
   fallback behind `BoxCipher`) is flagged "confirm with user," with a Hermes benchmark gate (Task 9
   Step 0) before locking it.
8. **Install discipline:** native modules (`react-native-zeroconf`, `expo-camera`, `expo-secure-store`,
   `expo-linking`) via `npx expo install`; pure-JS (`partysocket`, `tweetnacl`, `tweetnacl-util`,
   `qrcode-terminal`) via `bun add`. iOS `NSBonjourServices` + `NSLocalNetworkUsageDescription` +
   `NSCameraUsageDescription` and the Android perms are in `app.config.ts`.
9. **Conventions:** `SafeJSON` everywhere (no `JSON`); `out`/`logger` split (the wizard uses `out`
   for the QR/result, `logger` for diagnostics); no one-line ifs; blank line before `if` / after a
   closing brace; objects for 3+ params; no `as any` except the single documented `fetch`-shape cast.
10. **No placeholders:** every step shows runnable code, the exact command, and expected output. The
    managed-tier SSE path (`decryptingStreamSse`) and WS path (`wrapTerminalE2e`) are both shown in
    FULL — no `// implementer:` stubs remain. The managed-tier test wires the REAL `createE2eShim`.
11. **RN bundle safety (the contract is the only door):** Task 0 relocates the pure helpers
    (`makeBasicAuthHeader`, the pairing codec, the `E2eEnvelope` codec, `BoxCipher`/`KeyPair` types)
    into `@app/dev-dashboard/contract`; `lib/*` re-exports them for the Agent. **No mobile file
    value-imports from `@app/dev-dashboard/lib/*`** — every transport import goes through the contract
    (the JSON `test-vectors.json` import is data, not runtime, so it's bundle-safe). Plan 03's
    `contract-purity.test.ts` covers the four new files. Verify with:
    `cd DevDashboard/mobile && rg -n "from \"@app/dev-dashboard/lib" src/` → expect zero hits.

## Appium E2E (per ADR §8)

**Spec:** `DevDashboard/mobile/e2e/specs/connect.spec.ts` — the transport/trust done-gate.

**Page Object:** `DevDashboard/mobile/e2e/pages/ConnectPage.page.ts` (`ConnectPage`) with methods:
`isShown()`, `selectTier(tier)`, `reachabilityLabel()`, `isReachabilityState(kind)`,
`tapOpenTailscale()`, `tapTailscaleProbe()`, `isPairPanelShown()`, `isLanListShown()`,
`injectPairing(uri)` (deep-link instead of a real camera scan — the sim has no camera),
`tapContinue()`.

**Locators (accessibility-id, set as `accessibilityLabel` in Task 13):** `connect-screen`,
`connect-title`, `tier-picker`, `tier-option-{lan|tailscale|cloudflared-self|managed}`,
`reachability-badge`, `reachability-{idle|probing|reachable|unreachable|needs-vpn|needs-pair}`,
`lan-agent-list`, `lan-agent-{host}`, `lan-rescan`, `lan-scanning`, `tailscale-panel`,
`open-tailscale`, `tailscale-probe`, `pair-panel`, `qr-scanner-camera`, `qr-scanner-permission`,
`connect-continue`.

**MCP tools (the `appium` skill):** `select_device` → `appium_session_management` (action=create) →
`appium_find_element` (accessibility-id) → `appium_gesture` (tap) → `appium_get_text` (the
reachability label) → `appium_app_lifecycle` / the `mobile: deepLink` execute for `injectPairing`.
Use `appium_skills` first to verify the local Appium install/doctor before the run.

**Done definition:** the **Transport & Trust feature is "done" only when `connect.spec.ts` passes**
on the iOS simulator/dev-client (all 5 cases green), with a test Agent reachable on `127.0.0.1:3042`.

> **Plan-04 dependency for the "reaches the agent" case:** `connect.tsx` (Task 13) currently calls
> `setCloudflared(pairing, "")` / `setLan(agent, { …, password: "" })` because the Basic-auth password
> prompt is owned by plan 04's connect UX. With an empty password the probe gets `401` and the case
> stays red. To make this 5th spec case literally green, either (a) run the test Agent with auth
> disabled (`auth.enabled=false`), or (b) land plan 04's password prompt and inject the real password.
> Call this out in the PR; the other 4 cases are independent of it.

## Hand-off

- **Plan 04 (MobileFoundation)** bootstraps `DevDashboard/mobile/` (Expo SDK 55 scaffold, the e2e
  harness + `e2e`/`test` scripts, the design-system port, the `@app/dev-dashboard/contract` import
  mechanism). 02's mobile tasks (5-14) land on top of it; if 02 runs first, do the Agent-side tasks
  (1-4 server-side, 6a, 8, 9-10 Agent halves) and stub the mobile files for 04 to flesh out.
- **Plan 06 (Terminals)** consumes `Transport.openTerminal()` → `TerminalTransport`; the WebView/xterm
  drivers send/receive through it. The managed tier's `wrapTerminalE2e` means the renderer always sees
  plaintext frames regardless of tier.
- **Plan 07 (QA)** consumes `Transport.streamQa()` → `QaStream` + the AppState resync (Task 3 note).
- **Plan 10 (LandingAndManaged)** builds the vendor relay the managed tier points at and the device-
  code pairing UI; it MUST honor the key-custody invariant (public keys only; no private-key escrow).
- **Open item:** confirm the E2E crypto library (PROPOSED `tweetnacl`) with the user, and run the
  Task-9-Step-0 Hermes benchmark before locking it.
