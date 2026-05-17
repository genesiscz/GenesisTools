# ttyd on mobile — same-origin proxy: attempt #1 (reverted) + root cause + fix plan

**Status:** attempt #1 reverted (commit base `e1b70df1`). Real fix = Bun.serve front-proxy (attempt #2, below).

## Problem

`TtydPane` embedded `<iframe src="http://localhost:${port}">`. From a phone via
`https://mac.foltyn.dev` that `localhost` is the phone itself + `http://`
inside `https://` is mixed-content-blocked. Works on desktop only because that
browser runs on the same machine as ttyd.

## Root cause that blocked attempt #1

Bun GitHub issue **#28396** / PR **#28347** (state: OPEN as of 2026-03-30):
> "After an HTTP upgrade, `socket.write()` is a no-op — the 101 handshake
> response is never sent, and bidirectional streaming doesn't work. This breaks
> every WebSocket proxy in the Node ecosystem."

Confirmed locally with an isolated `node:http` server under `bun --bun`: the
`'upgrade'` event fires, `socket.writable === true`, we write a valid 101
(correct `Sec-WebSocket-Accept`), but **zero bytes reach the client**.
`http-proxy.web()` (uses `ServerResponse`) works; raw upgrade `socket.write`
does not. Vite must run under `bun --bun` here because `vite.config.ts`
dynamically `import()`s the `.ts` middleware (Node can't load `.ts` + `@app/*`).

No mainline Bun fix; only third-party fork `crunchloop/bun@bun-v1.3.11-dap.2`
(rejected — swapping the user's bun binary breaks `bun upgrade`).

`Bun.serve`'s **native** `server.upgrade()` + `websocket` handler works
perfectly under the same Bun (verified). → fix = a Bun.serve front-proxy.

## Attempt #1 implementation (REVERTED — kept here verbatim for recovery)

### `src/dev-dashboard/lib/ttyd/manager.ts` — spawn flags + accessor

Spawn args changed to serve ttyd under a reverse-proxy base-path, loopback-only:

```ts
const child = spawn(
    TTYD_BIN,
    ["-i","127.0.0.1","-b",`/ttyd/${id}`,"-W","-p",String(port),
     TMUX_BIN,"attach-session","-t",tmuxSessionName],
    { cwd, detached: true, stdio: "ignore" }
);
```

Plus an exported accessor:

```ts
export async function getTtydPort(id: string): Promise<number | null> {
    await hydrateRegistry();
    const tracked = registry.get(id);
    return tracked && isSessionAlive(tracked.session) ? tracked.session.port : null;
}
```

### `src/dev-dashboard/ui/src/components/TtydPane.tsx`

```tsx
<iframe src={`/ttyd/${session.id}/`} title={`ttyd-${session.id}`} className="flex-1 border-0 bg-black" />
```

### `src/dev-dashboard/ui/vite-middleware.ts` (added — does NOT work under Bun)

Imports: `import type { IncomingMessage, Server as HttpServer, ServerResponse } from "node:http"; import { connect as netConnect } from "node:net"; import type { Duplex } from "node:stream"; import httpProxy from "http-proxy-3";` and `getTtydPort` from the manager.

```ts
const ttydProxy = httpProxy.createProxyServer({ xfwd: true });
ttydProxy.on("error", (err) => logger.debug({ err }, "ttyd http proxy error"));

const TTYD_PATH = /^\/ttyd\/([0-9a-fA-F-]{36})(?:\/|$)/;

// raw TCP relay (manual) — replays upgrade, pipes both ways. Fails: Bun #28347.
function relayTtydWebSocket(req: IncomingMessage, socket: Duplex, head: Buffer, port: number): void {
    const upstream = netConnect(port, "127.0.0.1");
    const teardown = () => { upstream.destroy(); socket.destroy(); };
    upstream.on("error", teardown); socket.on("error", teardown);
    upstream.on("connect", () => {
        const lines = [`GET ${req.url} HTTP/1.1`];
        for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i+1]}`);
        upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
        if (head.length > 0) upstream.write(head);
        upstream.pipe(socket); socket.pipe(upstream);
    });
}

// HTTP side WORKS under Bun (uses ServerResponse). Auth bypass: unguessable UUID,
// discovery gated by /api/ttyd/list, ttyd loopback-only, Safari WS-auth flaky.
async function tryProxyTtydHttp(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
    const m = pathname.match(TTYD_PATH);
    if (!m) return false;
    const port = await getTtydPort(m[1]);
    if (!port) { res.statusCode = 502; res.end("ttyd session not found"); return true; }
    ttydProxy.web(req, res, { target: `http://127.0.0.1:${port}` });
    return true;
}

export function attachTtydProxyUpgrade(httpServer: HttpServer): void {
    httpServer.on("upgrade", (req, socket, head) => {
        const m = (req.url ?? "").match(TTYD_PATH);
        if (!m) return; // leave for Vite HMR. never destroy.
        getTtydPort(m[1]).then((port) => {
            if (!port) { socket.destroy(); return; }
            relayTtydWebSocket(req, socket, head, port);
        }).catch(() => socket.destroy());
    });
}
```

In `attachDevDashboardMiddleware`, first line of the handler:
`if (await tryProxyTtydHttp(req, res, url.pathname)) return;` (before auth).

### `src/dev-dashboard/ui/vite.config.ts`

```ts
const { attachDevDashboardMiddleware, attachTtydProxyUpgrade } = await import(...);
// configureServer:
attachDevDashboardMiddleware(server.middlewares);
if (server.httpServer) attachTtydProxyUpgrade(server.httpServer);
```

Also added then removed dep `http-proxy-3`.

## Attempt #2 — Bun.serve front-proxy (the real fix)

Architecture: `tools dev-dashboard` spawns Vite on an **internal loopback port**
(e.g. 3043), then `Bun.serve({ port: 3042 })` fronts it:

- `fetch(req, server)`:
  - `Upgrade: websocket`? choose target by URL: `/ttyd/<uuid>/...` → ttyd
    session port (via manager `getTtydPort`); anything else → Vite internal
    (Vite HMR `vite-hmr`). `server.upgrade(req, { data: { targetUrl, protocol } })`.
  - else `/ttyd/<uuid>/...` → `fetch("http://127.0.0.1:<ttydPort>"+path)`
    (auth-bypassed, same UUID rationale).
  - else → `fetch("http://127.0.0.1:3043"+path, {…req})` passthrough (auth still
    enforced by the existing Vite middleware downstream).
- `websocket` handlers: on `open`, create outbound `new WebSocket(targetUrl,
  protocols)`; queue inbound frames until outbound `open`; bridge
  `message`/`close` both directions; binary preserved (`ws.binaryType`).

Bun native `server.upgrade()` is NOT affected by #28347 (verified: open + recv
through Bun.serve works). HMR rides the same generic bridge.

`cloudflared` ingress (mac.foltyn.dev → 127.0.0.1:3042) unchanged.
