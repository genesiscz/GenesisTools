import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { startServer } from "./index";

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
