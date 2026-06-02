# Plan 02 — Agent-side implementation notes (Task 8 + Task 10 Step 5)

> Worktree: `.claude/worktrees/agent-a2b3ef4aba98c8627`, branch
> `worktree-agent-a2b3ef4aba98c8627`. Scope: agent side under `src/dev-dashboard/`
> only (the parallel agent owns `DevDashboard/mobile/`).

## 2026-05-29 — Worktree base correction (orchestrator flag)

The worktree was provisioned at the **wrong base**: HEAD was `581f71f70` on a
divergent CI-infra lineage (task/tests lane, debugging-master) that does **not**
contain `DevDashboard/`, `src/dev-dashboard/contract/`, `server/`, or `lib/e2e/` —
i.e. none of the files this task references existed. The intended base
`feat/dev-dashboard-mobile @ 61b7c9f65` was checked out in a *different* worktree
(`.worktrees/feat-dev-dashboard-mobile`).

Working tree was clean (no uncommitted work). Fix:

```bash
git branch backup/agent-a2b3ef-wrongbase 581f71f70   # insurance ref for the 19 inherited commits
git reset --hard 61b7c9f65
bun install                                           # 74-commit base delta; tweetnacl/bonjour-service link
```

After reset all referenced files resolved. **If sibling agents are provisioned the
same way, their base is likely wrong too — check before they start writing.**

## What was built

### Task 8 — self-hosted cloudflared wizard (commit `1fdce8ea3`)

- `src/dev-dashboard/lib/tunnel/cloudflared.ts` (+ `.test.ts`) — pure builders
  (`buildCreateArgs`, `buildRouteDnsArgs`, `buildRunArgs`, `parseTunnelId`,
  `buildConfigYaml`, `cloudflaredHome`) + thin `Bun.spawn` wrappers
  (`detectCloudflared`, `installCloudflared`, `runCloudflared`, `loginCloudflared`,
  `createTunnel`, `routeDns`, `writeConfig`, `runTunnel`) +
  `requestManagedSubdomain(...)` stub (D10). Tests cover ONLY the pure builders
  (6 + 1 = 6 builder + config-yaml assertions; binary never spawned).
- `src/dev-dashboard/lib/tunnel/pairing.ts` (+ `.test.ts`) — re-exports the pure
  codec from `@app/dev-dashboard/contract/pairing` and adds disk persistence
  (`~/.genesis-tools/dev-dashboard/tunnel.json`, chmod 0600) via
  `persistTunnelConfig` / `loadTunnelConfig` / `persistPairing` (persists the built
  `PairingPayload` URI alongside the tunnel config).
- `src/dev-dashboard/commands/tunnel.ts` — the `@clack/prompts` wizard. Non-TTY
  guard (`isInteractive()` + `suggestCommand()`). Branches: **own-domain** (CF
  login → create → route DNS → write config → pairing QR) vs **managed-subdomain**
  (D10; shows the TRUST CAVEAT note, confirms, calls `requestManagedSubdomain`).
  QR via `renderQr` from `@app/utils/qr` (synchronous; reuses the existing
  `qrcode-terminal` dep — no new lib).
- `src/dev-dashboard/index.ts` — registered the `tunnel setup` subcommand
  (commander), mirroring the `agent` pattern.

### Task 10 Step 5 — e2e-rpc serve interception (commit `5dbfdcab0`)

- `src/dev-dashboard/server/transport/e2e-rpc.ts` (+ `.test.ts`) — the pure,
  port-free `handleE2eRpc(rawEnvelope, deps)` extracted so serve.ts is a thin
  caller. Builds `createE2eShim` per call; its `handle` closure does
  `decodeE2eRequest` → synthetic `Request("http://e2e.local"+path, …)` →
  `routerToResponse(router, …, { services })` → encode `E2eResponse`.
  - **Two distinct error layers** (the load-bearing design decision):
    - crypto/pairing/envelope failure → **throws** (serve.ts → generic plaintext
      403, no detail leaked → no decryption oracle; real reason `logger.warn`'d).
    - successful decrypt but no route → **encrypted `E2eResponse{404}`** (a normal
      404 the phone decrypts), returned as a 200 envelope. Not the 403 path.
  - SSE route (`text/event-stream`) → **encrypted `E2eResponse{501}`** +
    `await res.body?.cancel()` to tear down the never-closing stream (resource-leak
    guard). `// TODO(plan-02): streaming E2E` marks the deferral.
  - GET/HEAD body guard (a `Request` with a GET body throws `TypeError`).
- `src/dev-dashboard/server/serve.ts` — added `e2e?: boolean` to
  `ServeAgentOptions`. When on, builds the agent keypair ONCE at startup
  (`loadOrCreateAgentKeys`), intercepts `POST /api/e2e/rpc` BEFORE the router via
  `serveE2eRpc(...)`, which snapshots `loadPeers()` **per request** and closes a
  **sync** `resolvePeerKey` over it (the shim's `resolvePeerKey` is sync but
  `loadPeers` is async — resolved by snapshot-per-request, keygen-once). Returns
  the **stored** key bytes, never the request's claimed `epk`. Extracted
  `denyResponse(auth)` for the auth-decision→Response mapping.
- **Auth bypass:** `/api/e2e/rpc` and `/api/e2e/pair` skip `decideApiAuth` — the
  allowlist+box MAC is the auth for rpc, pairing is TOFU-public. Everything else
  still runs `decideApiAuth` + cookie minting unchanged. Default-off: with `e2e`
  unset the fetch handler is byte-equivalent to before.
- `src/dev-dashboard/index.ts` — plumbed `--e2e` into the `agent` subcommand
  (default off).

## Already done upstream (no change needed)

- `e2eRoutes()` is **already wired** into `createDashboardRouter()`
  (`registry.ts:35`) and `"POST /api/e2e/pair"` is **already** in the `EXPECTED`
  array (`registry.test.ts:48`). The plan's Task 10 Step 5 asks to add these, but
  they pre-exist on this base — registry.ts / registry.test.ts were NOT touched.

## Test + tsgo results

- `bun test src/dev-dashboard/lib/tunnel/ src/dev-dashboard/server/transport/ src/dev-dashboard/contract/` → **33 pass, 0 fail** (8 files).
  - tunnel: cloudflared 6 + pairing 4 = 10; transport: e2e-rpc 8 + e2e-shim 2 +
    mdns 3 = 13; contract: 10.
- `bun test src/dev-dashboard/server/registry.test.ts` → 1 pass.
- `bunx tsgo --noEmit` → **0 total errors** (whole repo).
- Per instructions, did NOT run a broad `bun test src/dev-dashboard/` (pulls
  e2e/integration tests that SIGKILL / collide with the live :3042 dashboard), and
  never started `serveAgent`, bound a port, or ran a real `cloudflared`.

## Deviations from the plan text

- The plan's Task 10 Step 5 sketched a header-gated (`x-dd-e2e: 1`) inline
  intercept; the task spec (authoritative + more precise) called for a dedicated
  `POST /api/e2e/rpc` + `decodeE2eRequest`/`encodeE2eResponse` + pure
  `handleE2eRpc`. Built to the spec.
- Plan's wizard code omitted the non-TTY guard and used the raw `qrcode.generate`
  callback; replaced with `isInteractive()`/`suggestCommand()` + `renderQr`.
- Plan listed `createTunnel/routeDns/runTunnel/writeConfig`; the plan's own test
  imports `buildCreateArgs/buildRouteDnsArgs/buildRunArgs/parseTunnelId`. Kept BOTH
  — pure builders (tested) + named spawn wrappers layered on top. Added a pure
  `buildConfigYaml` (unit-tested); `writeConfig` just writes it.

## Deferred / out of scope

- **Streaming over E2E rpc** (SSE `/api/qa/stream`, WS terminals) — `// TODO(plan-02)`.
  rpc returns an encrypted 501 for `text/event-stream`.
- **`requestManagedSubdomain`** throws `"DevDashboard Cloud API not implemented
  (plan 10)"` behind a typed `ManagedSubdomainResult` interface (`// TODO(plan-10)`).
  No endpoints invented — plan 10 wires the real HTTP call.

## ORCHESTRATOR FLAGS (read these)

1. **`--e2e` is NOT production-safe until `/api/e2e/pair` authenticates pairing.**
   `routes/e2e.ts` `addPeer` stores *any* posted public key (the `deviceCode` check
   is a `// would be verified` TODO). Combined with the auth bypass, **anyone who
   can reach the agent — including the untrusted vendor relay that D9/D11's "we
   can't see your data" defends against — can POST their own pubkey, land in the
   allowlist, and get rpc responses sealed to their key.** That defeats the no-see
   guarantee. The pair route is pre-existing (Task 10 Step 4), outside this Step-5
   scope, so it was NOT changed. **Fix before shipping `--e2e`:** bind pairing to a
   short-lived device code shown on the Mac during `tunnel setup --managed` (the
   intended `deviceCode` flow), or otherwise authenticate the pair POST.

2. **Mobile ↔ agent rpc payload mismatch (Task 11, other agent).** The agent rpc
   expects the inner plaintext to be **`E2eRequest` JSON** (`decodeE2eRequest`). The
   plan's Task 11 mobile sketch (`e2e-transport.ts`) encodes a `"METHOD path\n\nbody"`
   **line** and POSTs to `/api/e2e/exchange`, not `/api/e2e/rpc`. These will not
   interop. The mobile side must encode `E2eRequest` JSON and target
   `POST /api/e2e/rpc`.

3. **Managed-subdomain API stub.** `requestManagedSubdomain` is a typed seam that
   throws until plan 10 builds the DevDashboard Cloud API. The wizard's managed
   branch catches it and shows a graceful "not available yet" note.

4. **`serveE2eRpc`'s generic-403 mapping is untested** (it calls real `loadPeers()`
   → disk, so it sits on the impure side of the split). Correct by inspection (every
   `handleE2eRpc` throw → one 403 shape). Could be pinned with a mock-`Request`
   bad-envelope→403 assertion if desired; left out to keep the pure/impure split.
