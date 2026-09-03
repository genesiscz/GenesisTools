import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { MASKED_HEADER_VALUE } from "../types";
import { isAllowedHost, startServer } from "./index";

let handle: Awaited<ReturnType<typeof startServer>>;
let base: string;

beforeAll(async () => {
    handle = await startServer({ port: 0, dbPath: ":memory:", schedule: false });
    base = `http://127.0.0.1:${handle.port}`;
    await handle.monitor.createTarget({
        name: "family",
        channel: "telegram",
        config: { botToken: "123:SECRET", chatId: "-100" },
    });
});

afterAll(async () => {
    await handle.stop();
});

describe("monitor server target responses", () => {
    test("GET /targets reports whether a secret is set, never the secret", async () => {
        const response = await fetch(`${base}/api/v1/targets`);
        const body = (await response.json()) as { targets: Array<{ config: Record<string, unknown> }> };

        expect(response.status).toBe(200);
        expect(body.targets[0].config).toEqual({ botTokenSet: true, chatId: "-100" });
        expect(SafeJSON.stringify(body)).not.toContain("123:SECRET");
    });

    test("PATCH echoes the masked target back", async () => {
        const response = await fetch(`${base}/api/v1/targets/1`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: SafeJSON.stringify({ config: { chatId: "-200" } }),
        });
        const body = (await response.json()) as { target: { config: Record<string, unknown> } };

        expect(response.status).toBe(200);
        expect(body.target.config).toEqual({ botTokenSet: true, chatId: "-200" });

        // The stored secret survived a patch that could not carry it.
        expect((await handle.monitor.getTarget(1))?.config.botToken).toBe("123:SECRET");
    });
});

describe("monitor server watcher responses", () => {
    const SECRET = "Bearer super-secret";

    test("every route that returns a watcher masks config.headers", async () => {
        // maskWatcher used to run only on the WebSocket event stream, so the
        // same Authorization token the stream hid was returned verbatim by
        // list, get, create, patch and run.
        const created = await fetch(`${base}/api/v1/watchers`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: SafeJSON.stringify({
                name: "private site",
                kind: "website",
                // Refused at once, so the create route's own initial check
                // settles before the assertions below.
                target: "http://127.0.0.1:1/health",
                enabled: false,
                notify: false,
                timeoutMs: 1_000,
                config: { headers: { Authorization: SECRET } },
            }),
        });
        const { watcher } = (await created.json()) as { watcher: { id: number; config: { headers: unknown } } };

        expect(created.status).toBe(201);
        expect(watcher.config.headers).toEqual({ Authorization: MASKED_HEADER_VALUE });

        for (const path of ["/watchers", `/watchers/${watcher.id}`, "/overview"]) {
            const response = await fetch(`${base}/api/v1${path}`);

            expect(SafeJSON.stringify(await response.json())).not.toContain("super-secret");
        }

        const patched = await fetch(`${base}/api/v1/watchers/${watcher.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: SafeJSON.stringify({ name: "private site 2" }),
        });

        expect(SafeJSON.stringify(await patched.json())).not.toContain("super-secret");

        // The check itself must still send the real header.
        expect((await handle.monitor.getWatcher(watcher.id))?.config.headers).toEqual({ Authorization: SECRET });
        await handle.monitor.deleteWatcher(watcher.id);
    });

    test("the run outcome masks the watcher it carries", async () => {
        const created = await handle.monitor.createWatcher({
            name: "run me",
            kind: "website",
            target: "http://127.0.0.1:1/health",
            enabled: false,
            notify: false,
            timeoutMs: 1_000,
            config: { headers: { Authorization: SECRET } },
        });
        const response = await fetch(`${base}/api/v1/watchers/${created.id}/run`, { method: "POST" });
        const outcome = (await response.json()) as { watcher: { config: { headers: unknown } } };

        expect(response.status).toBe(200);
        expect(outcome.watcher.config.headers).toEqual({ Authorization: MASKED_HEADER_VALUE });
        await handle.monitor.deleteWatcher(created.id);
    });

    test("a patch that echoes the masked header back keeps the stored value", async () => {
        const created = await handle.monitor.createWatcher({
            name: "round trip",
            kind: "website",
            target: "https://example.invalid/health",
            enabled: false,
            notify: false,
            config: { headers: { Authorization: SECRET }, expectStatus: 200 },
        });
        const response = await fetch(`${base}/api/v1/watchers/${created.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: SafeJSON.stringify({
                config: { headers: { Authorization: MASKED_HEADER_VALUE }, expectStatus: 204 },
            }),
        });

        expect(response.status).toBe(200);

        const stored = await handle.monitor.getWatcher(created.id);
        expect(stored?.config.headers).toEqual({ Authorization: SECRET });
        expect(stored?.config.expectStatus).toBe(204);
        await handle.monitor.deleteWatcher(created.id);
    });
});

describe("monitor server host policy", () => {
    test("isAllowedHost accepts loopback names and IP literals, refuses DNS names", () => {
        expect(isAllowedHost(null)).toBe(true);
        expect(isAllowedHost("127.0.0.1:3077")).toBe(true);
        expect(isAllowedHost("localhost:3077")).toBe(true);
        expect(isAllowedHost("monitor.localhost")).toBe(true);
        expect(isAllowedHost("[::1]:3077")).toBe(true);
        expect(isAllowedHost("evil.example:3077")).toBe(false);
        expect(isAllowedHost("LOCALHOST.evil.example")).toBe(false);
    });

    test("a GET whose Host is a rebound DNS name is refused", async () => {
        // DNS rebinding makes the attacker page same-origin, so no Origin is
        // sent and the cross-origin write guard never fires. The Host still
        // names evil.example, and that is the only thing left to check.
        const response = await fetch(`${base}/api/v1/watchers`, { headers: { Host: "evil.example" } });

        expect(response.status).toBe(403);
    });
});

describe("monitor server origin policy", () => {
    test("no Access-Control-Allow-Origin: the dashboard is same-origin", async () => {
        const response = await fetch(`${base}/api/v1/healthz`);

        expect(response.headers.get("access-control-allow-origin")).toBeNull();
    });

    test("a cross-origin write is refused", async () => {
        const response = await fetch(`${base}/api/v1/targets`, {
            method: "POST",
            headers: { "Content-Type": "text/plain", Origin: "https://evil.example" },
            body: SafeJSON.stringify({ name: "pwned", channel: "webhook", config: { url: "https://evil.example/h" } }),
        });

        expect(response.status).toBe(403);
        expect(await handle.monitor.listTargets()).toHaveLength(1);
    });

    test("a write from the dashboard's own loopback origin still works", async () => {
        const response = await fetch(`${base}/api/v1/targets`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Origin: "http://localhost:3077" },
            body: SafeJSON.stringify({ name: "ops", channel: "webhook", config: { url: "https://a.dev/hook" } }),
        });

        expect(response.status).toBe(201);
        await handle.monitor.deleteTarget(((await response.json()) as { target: { id: number } }).target.id);
    });

    test("a write with no Origin (curl, the CLI) still works", async () => {
        const response = await fetch(`${base}/api/v1/targets`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: SafeJSON.stringify({ name: "cli", channel: "webhook", config: { url: "https://a.dev/hook" } }),
        });

        expect(response.status).toBe(201);
        await handle.monitor.deleteTarget(((await response.json()) as { target: { id: number } }).target.id);
    });
});

describe("monitor server origin policy: other local ports and the event socket", () => {
    test("a loopback page on a foreign port is another program, not the dashboard", async () => {
        const response = await fetch(`${base}/api/v1/targets`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Origin: "http://localhost:9999" },
            body: SafeJSON.stringify({ name: "other", channel: "webhook", config: { url: "https://a.dev/hook" } }),
        });

        expect(response.status).toBe(403);
    });
});

describe("monitor server event stream", () => {
    test("a cross-origin websocket upgrade is refused", async () => {
        // Browsers apply no CORS to WebSockets, and the upgrade is a GET, so the
        // cross-origin WRITE guard never sees it. The stream carries every
        // watcher, whose config.headers can hold an Authorization bearer.
        const response = await fetch(`${base}/api/v1/events`, {
            headers: {
                Origin: "https://evil.example",
                Connection: "Upgrade",
                Upgrade: "websocket",
                "Sec-WebSocket-Version": "13",
                "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
            },
        });

        expect(response.status).toBe(403);
        expect(((await response.json()) as { error: string }).error).toContain("cross-origin");
    });

    test("a real websocket handshake from another page never opens", async () => {
        const socket = new WebSocket(`ws://127.0.0.1:${handle.port}/api/v1/events`, {
            headers: { Origin: "https://evil.example" },
        } as unknown as string[]);
        const opened = await new Promise<boolean>((resolve) => {
            socket.addEventListener("open", () => resolve(true), { once: true });
            socket.addEventListener("error", () => resolve(false), { once: true });
            socket.addEventListener("close", () => resolve(false), { once: true });
        });
        socket.close();

        expect(opened).toBe(false);
    });

    test("the dashboard's own loopback origin still connects", async () => {
        const socket = new WebSocket(`ws://127.0.0.1:${handle.port}/api/v1/events`, {
            headers: { Origin: `http://localhost:${handle.port}` },
        } as unknown as string[]);
        const hello = await new Promise<string>((resolve, reject) => {
            socket.addEventListener("message", (event) => resolve(String(event.data)), { once: true });
            socket.addEventListener("error", () => reject(new Error("websocket refused")), { once: true });
        });
        socket.close();

        expect(SafeJSON.parse(hello, { strict: true })).toEqual({ type: "hello", protocolVersion: 1 });
    });

    test("a websocket with no Origin (the CLI, a test) still connects", async () => {
        const socket = new WebSocket(`ws://127.0.0.1:${handle.port}/api/v1/events`);
        const hello = await new Promise<string>((resolve, reject) => {
            socket.addEventListener("message", (event) => resolve(String(event.data)), { once: true });
            socket.addEventListener("error", () => reject(new Error("websocket refused")), { once: true });
        });
        socket.close();

        expect(SafeJSON.parse(hello, { strict: true })).toEqual({ type: "hello", protocolVersion: 1 });
    });
});
