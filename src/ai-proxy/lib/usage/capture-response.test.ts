import { describe, expect, it } from "bun:test";
import { captureResponseBody } from "@app/ai-proxy/lib/usage/capture-response";

function sseResponse(chunks: string[], options: { close?: boolean } = {}): Response {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const chunk of chunks) {
                controller.enqueue(encoder.encode(chunk));
            }

            if (options.close !== false) {
                controller.close();
            }
            // when close is false the stream stays open forever, which is exactly
            // the upstream behaviour that used to hang the capture promise
        },
    });

    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

describe("captureResponseBody", () => {
    it("captures a normal stream and reports no failure", async () => {
        const captured = captureResponseBody(sseResponse(['data: {"a":1}\n\n', "data: [DONE]\n\n"]));

        expect(await captured.responseBody).toContain("[DONE]");
        expect(await captured.captureFailure).toBeUndefined();
        // the client branch is still readable and untouched
        expect(await captured.response.text()).toContain('{"a":1}');
    });

    it("keeps the client branch byte-identical to what upstream sent", async () => {
        const frames = ['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', "data: [DONE]\n\n"];
        const captured = captureResponseBody(sseResponse(frames));

        const [client, capture] = await Promise.all([captured.response.text(), captured.responseBody]);
        expect(client).toBe(frames.join(""));
        expect(capture).toBe(frames.join(""));
    });

    it("resolves the timeline even when the body is empty", async () => {
        const captured = captureResponseBody(new Response(null, { status: 204 }));

        expect(await captured.responseBody).toBe("");
        expect((await captured.timeline).upstreamHeadersMs).toBeGreaterThanOrEqual(0);
        expect(await captured.captureFailure).toBeUndefined();
    });
});
