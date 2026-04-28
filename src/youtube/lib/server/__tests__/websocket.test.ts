import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { startServer } from "@app/youtube/lib/server";

interface WsMessage {
    type: string;
    job?: { id: number };
    jobId?: number;
}

describe("youtube server websocket", () => {
    it("responds to ping and broadcasts pipeline events", async () => {
        const dir = await mkdtemp(join(tmpdir(), "youtube-server-ws-"));
        const handle = await startServer({ port: 0, baseDir: dir, startPipeline: false });
        const ws = new WebSocket(`ws://localhost:${handle.port}/api/v1/events`);

        try {
            const hello = await nextMessage(ws);
            expect(hello.type).toBe("hello");

            ws.send(SafeJSON.stringify({ type: "ping" }));
            const pong = await nextMessage(ws);
            expect(pong.type).toBe("pong");

            const job = handle.youtube.pipeline.enqueue({
                targetKind: "video",
                target: "abc123def45",
                stages: ["metadata"],
            });
            const created = await nextMessage(ws);

            expect(created.type).toBe("job:created");
            expect(created.job?.id).toBe(job.id);
        } finally {
            ws.close();
            await handle.stop();
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("filters events by subscribed job ids", async () => {
        const dir = await mkdtemp(join(tmpdir(), "youtube-server-ws-"));
        const handle = await startServer({ port: 0, baseDir: dir, startPipeline: false });
        const ws = new WebSocket(`ws://localhost:${handle.port}/api/v1/events`);

        try {
            await nextMessage(ws);

            ws.send(SafeJSON.stringify({ type: "subscribe", jobIds: [2] }));
            const subscribed = await nextMessage(ws);
            expect(subscribed.type).toBe("subscribed");

            handle.youtube.pipeline.enqueue({ targetKind: "video", target: "first", stages: ["metadata"] });
            const secondJob = handle.youtube.pipeline.enqueue({
                targetKind: "video",
                target: "second",
                stages: ["metadata"],
            });
            const created = await nextMessage(ws);

            expect(secondJob.id).toBe(2);
            expect(created.type).toBe("job:created");
            expect(created.job?.id).toBe(2);
        } finally {
            ws.close();
            await handle.stop();
            await rm(dir, { recursive: true, force: true });
        }
    });
});

function nextMessage(ws: WebSocket): Promise<WsMessage> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error("timed out waiting for websocket message"));
        }, 1_000);

        function cleanup(): void {
            clearTimeout(timeout);
            ws.removeEventListener("message", onMessage);
            ws.removeEventListener("error", onError);
        }

        function onMessage(event: MessageEvent): void {
            cleanup();
            resolve(SafeJSON.parse(String(event.data)) as WsMessage);
        }

        function onError(): void {
            cleanup();
            reject(new Error("websocket error"));
        }

        ws.addEventListener("message", onMessage);
        ws.addEventListener("error", onError);
    });
}
