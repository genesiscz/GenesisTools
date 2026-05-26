import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { handleDashboardRequest } from "@app/debugging-master/core/dashboard-server";
import { startServer } from "@app/debugging-master/core/http-server";
import { sseBroadcaster } from "@app/debugging-master/core/sse-broadcaster";
import { jsonlPath } from "@app/task/lib/paths";
import { SafeJSON } from "@app/utils/json";

const homeDir = join(fileURLToPath(new URL("../../..", import.meta.url)), ".tmp-dashboard-test");
let port = 0;
let server: ReturnType<typeof startServer>["server"];

beforeAll(() => {
    process.env.GENESIS_TOOLS_HOME = homeDir;
    mkdirSync(join(homeDir, ".genesis-tools", "task", "sessions"), { recursive: true });
    const started = startServer(0);
    server = started.server;
    port = started.port;
});

afterAll(() => {
    sseBroadcaster.reset();
    server.stop();
    delete process.env.GENESIS_TOOLS_HOME;
});

async function fetchApi(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}${path}`, init);
}

describe("task dashboard integration", () => {
    it("lists task sessions in unified /api/sessions", async () => {
        const session = `dash-${Date.now()}`;
        const path = jsonlPath(session);
        mkdirSync(join(path, ".."), { recursive: true });
        appendFileSync(
            path,
            `${SafeJSON.stringify({ type: "line", seq: 1, out: "stdout", ts: Date.now(), text: "hello dash" })}\n`
        );

        const res = await fetchApi("/api/sessions");
        expect(res.ok).toBe(true);
        const body = (await res.json()) as { sessions: Array<{ source: string; name: string; badge: string }> };
        expect(body.sessions.some((s) => s.source === "task" && s.name === session)).toBe(true);
    });

    it("streams task session entries over SSE", async () => {
        const session = `sse-${Date.now()}`;
        const path = jsonlPath(session);
        appendFileSync(path, "");

        const ac = new AbortController();
        const res = await fetchApi(`/api/sessions/task/${session}/stream`, { signal: ac.signal });
        expect(res.ok).toBe(true);

        const reader = res.body?.getReader();
        expect(reader).toBeTruthy();

        appendFileSync(
            path,
            `${SafeJSON.stringify({ type: "line", seq: 1, out: "stdout", ts: Date.now(), text: "live line" })}\n`
        );

        const decoder = new TextDecoder();
        let found = false;
        const deadline = Date.now() + 5000;

        while (Date.now() < deadline && !found) {
            const { value, done } = await reader!.read();
            if (done) {
                break;
            }

            const chunk = decoder.decode(value);
            if (chunk.includes("live line")) {
                found = true;
            }
        }

        ac.abort();
        expect(found).toBe(true);
    }, 10_000);

    it("serves task sessions with colon collision suffix (entries + stream)", async () => {
        const session = "metro-2026-05-26_14:30:22";
        const path = jsonlPath(session);
        appendFileSync(
            path,
            `${SafeJSON.stringify({ type: "line", seq: 1, out: "stdout", ts: Date.now(), text: "colon session line", level: "info" })}\n`
        );

        const encoded = encodeURIComponent(session);
        const entriesRes = await fetchApi(`/api/sessions/task/${encoded}/entries?since=0&limit=10`);
        expect(entriesRes.status).toBe(200);

        const entriesBody = (await entriesRes.json()) as { entries: Array<{ msg?: string; text?: string }> };
        const text = entriesBody.entries[0]?.msg ?? entriesBody.entries[0]?.text ?? "";
        expect(text).toContain("colon session line");

        const ac = new AbortController();
        const streamRes = await fetchApi(`/api/sessions/task/${encoded}/stream`, { signal: ac.signal });
        expect(streamRes.status).toBe(200);
        ac.abort();
    });

    it("handleDashboardRequest resolves legacy dbg routes", async () => {
        const url = new URL(`http://127.0.0.1:${port}/api/sessions`);
        const res = await handleDashboardRequest(new Request(url), url, {});
        expect(res?.status).toBe(200);
    });
});
