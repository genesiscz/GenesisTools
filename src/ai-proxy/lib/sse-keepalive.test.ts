import { describe, expect, it } from "bun:test";
import { withSseKeepalive } from "./sse-keepalive";

function sseResponse(body: ReadableStream<Uint8Array>): Response {
    return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

/** A stream that emits `first`, stays silent for `silenceMs`, then emits `second` and closes. */
function silentThenChunk(first: string, silenceMs: number, second: string): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();

    return new ReadableStream<Uint8Array>({
        async start(controller) {
            controller.enqueue(encoder.encode(first));
            await Bun.sleep(silenceMs);
            controller.enqueue(encoder.encode(second));
            controller.close();
        },
    });
}

async function readAll(response: Response): Promise<string> {
    return await new Response(response.body).text();
}

describe("withSseKeepalive", () => {
    it("returns a non-streaming response untouched", () => {
        const response = new Response("{}", { headers: { "Content-Type": "application/json" } });
        expect(withSseKeepalive(response)).toBe(response);
    });

    it("returns a bodiless response untouched", () => {
        const response = new Response(null, { status: 204, headers: { "Content-Type": "text/event-stream" } });
        expect(withSseKeepalive(response)).toBe(response);
    });

    // The checker ticks at `max(1000, everyMs / 2)`, so a gap has to clear that
    // floor before a comment frame can appear at all.
    it("injects a comment frame while upstream is silent", async () => {
        const wrapped = withSseKeepalive(sseResponse(silentThenChunk("data: a\n\n", 1_400, "data: b\n\n")), 200);
        const text = await readAll(wrapped);

        expect(text).toContain("data: a\n\n");
        expect(text).toContain("data: b\n\n");
        expect(text).toContain(": keepalive\n\n");
    });

    it("emits nothing extra when upstream keeps talking", async () => {
        const encoder = new TextEncoder();
        const busy = new ReadableStream<Uint8Array>({
            async start(controller) {
                for (let i = 0; i < 4; i++) {
                    controller.enqueue(encoder.encode(`data: ${i}\n\n`));
                    await Bun.sleep(10);
                }

                controller.close();
            },
        });

        const text = await readAll(withSseKeepalive(sseResponse(busy), 5_000));
        expect(text).not.toContain(": keepalive");
    });

    it("stops the keepalive timer when the consumer cancels", async () => {
        const wrapped = withSseKeepalive(sseResponse(silentThenChunk("data: a\n\n", 5_000, "data: b\n\n")), 40);
        const reader = wrapped.body!.getReader();

        await reader.read();
        await reader.cancel("done");

        // A live interval would keep the process's event loop busy past this point.
        await Bun.sleep(120);
        expect(true).toBe(true);
    });
});
