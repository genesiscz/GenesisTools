import { setupStorageSandbox } from "@app/utils/storage/test-sandbox";

setupStorageSandbox();

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handleDashboardRequest } from "@app/debugging-master/core/dashboard-server";
import { startServer } from "@app/debugging-master/core/http-server";
import { sseBroadcaster } from "@app/debugging-master/core/sse-broadcaster";
import { jsonlPath, metaPath, uiJsonlPath } from "@app/task/lib/paths";
import { SafeJSON } from "@app/utils/json";

let port = 0;
let server: ReturnType<typeof startServer>["server"];

beforeAll(() => {
    const homeDir = process.env.GENESIS_TOOLS_HOME;
    if (!homeDir) {
        throw new Error("GENESIS_TOOLS_HOME must be set by setupStorageSandbox");
    }

    mkdirSync(join(homeDir, ".genesis-tools", "task", "sessions"), { recursive: true });
    const started = startServer(0);
    server = started.server;
    port = started.port;
});

afterAll(() => {
    sseBroadcaster.reset();
    server.stop();
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

    it("does not list dashboard ui jsonl mirrors as sessions", async () => {
        const session = `ui-mirror-${Date.now()}`;
        const path = jsonlPath(session);
        appendFileSync(path, `${SafeJSON.stringify({ type: "meta", session, command: "echo", cwd: "/tmp" })}\n`);
        appendFileSync(
            uiJsonlPath(session),
            `${SafeJSON.stringify({ type: "line", seq: 1, text: "ansi mirror" })}\n`
        );

        const res = await fetchApi("/api/sessions");
        expect(res.ok).toBe(true);
        const body = (await res.json()) as { sessions: Array<{ source: string; name: string }> };
        expect(body.sessions.some((s) => s.source === "task" && s.name === session)).toBe(true);
        expect(body.sessions.some((s) => s.source === "task" && s.name === `${session}.ui`)).toBe(false);
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

    it("DELETE removes task session files", async () => {
        const session = `del-${Date.now()}`;
        const path = jsonlPath(session);
        appendFileSync(path, `${SafeJSON.stringify({ type: "line", seq: 1, out: "stdout", ts: Date.now(), text: "bye" })}\n`);

        const encoded = encodeURIComponent(session);
        const delRes = await fetchApi(`/api/sessions/task/${encoded}`, { method: "DELETE" });
        expect(delRes.status).toBe(200);

        const listRes = await fetchApi("/api/sessions");
        const body = (await listRes.json()) as { sessions: Array<{ name: string }> };
        expect(body.sessions.some((s) => s.name === session)).toBe(false);
    });

    it("multiplex stream for active sessions via single SSE request", async () => {
        const session = `active-${Date.now()}`;
        const path = jsonlPath(session);
        const now = Date.now();
        appendFileSync(path, "");
        appendFileSync(
            metaPath(session),
            SafeJSON.stringify({
                name: session,
                command: "echo test",
                mode: "pipe",
                cwd: "/tmp",
                createdAt: now,
                lastActivityAt: now,
                startedAt: new Date(now).toISOString(),
            })
        );

        const ac = new AbortController();
        const streamRes = await fetchApi("/api/sessions/stream?active=1", { signal: ac.signal });
        expect(streamRes.status).toBe(200);

        appendFileSync(
            path,
            `${SafeJSON.stringify({ type: "line", seq: 1, out: "stdout", ts: Date.now(), text: "multiplex line", level: "info" })}\n`
        );

        const reader = streamRes.body?.getReader();
        const decoder = new TextDecoder();
        let found = false;
        const deadline = Date.now() + 8000;

        while (Date.now() < deadline && !found) {
            const { value, done } = await reader!.read();
            if (done) {
                break;
            }

            const chunk = decoder.decode(value);
            if (chunk.includes("multiplex line") && chunk.includes(session)) {
                found = true;
            }
        }

        ac.abort();
        expect(found).toBe(true);
    }, 15_000);

    it("emits cleared SSE when a tailed task session log file is truncated", async () => {
        const session = `clear-${Date.now()}`;
        const path = jsonlPath(session);
        const now = Date.now();
        appendFileSync(
            path,
            `${SafeJSON.stringify({ type: "line", seq: 1, out: "stdout", ts: now, text: "before clear" })}\n`
        );
        appendFileSync(
            metaPath(session),
            SafeJSON.stringify({
                name: session,
                command: "echo test",
                mode: "pipe",
                cwd: "/tmp",
                createdAt: now,
                lastActivityAt: now,
                startedAt: new Date(now).toISOString(),
            })
        );

        const ac = new AbortController();
        const streamRes = await fetchApi(`/api/sessions/task/${encodeURIComponent(session)}/stream`, {
            signal: ac.signal,
        });
        expect(streamRes.status).toBe(200);

        writeFileSync(path, "");
        await Bun.sleep(400);

        writeFileSync(
            path,
            `${SafeJSON.stringify({ type: "line", seq: 1, out: "stdout", ts: Date.now(), text: "after clear" })}\n`
        );

        const reader = streamRes.body?.getReader();
        const decoder = new TextDecoder();
        let sawCleared = false;
        let sawFreshLine = false;
        const deadline = Date.now() + 8000;

        while (Date.now() < deadline && !(sawCleared && sawFreshLine)) {
            const { value, done } = await reader!.read();
            if (done) {
                break;
            }

            const chunk = decoder.decode(value);
            if (chunk.includes("event: cleared") && chunk.includes(session)) {
                sawCleared = true;
            }

            if (chunk.includes("after clear")) {
                sawFreshLine = true;
            }
        }

        ac.abort();
        expect(sawCleared).toBe(true);
        expect(sawFreshLine).toBe(true);
    }, 15_000);

    it("sessions list includes state field", async () => {
        const res = await fetchApi("/api/sessions");
        const body = (await res.json()) as { sessions: Array<{ state?: string; stateLabel?: string }> };
        for (const session of body.sessions) {
            expect(["active", "exited", "unknown"]).toContain(session.state);
            expect(typeof session.stateLabel).toBe("string");
        }
    });
});
