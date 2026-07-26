import { describe, expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { AiProxyClient } from "./AiProxyClient";

/** Serve one SSE stream and record what the client asked for. */
function serveSse(frames: string[]): { url: string; stop: () => void } {
    const server = Bun.serve({
        port: 0,
        fetch() {
            const encoder = new TextEncoder();
            return new Response(
                new ReadableStream({
                    start(controller) {
                        for (const frame of frames) {
                            controller.enqueue(encoder.encode(`data: ${frame}\n\n`));
                        }

                        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                        controller.close();
                    },
                }),
                { headers: { "Content-Type": "text/event-stream" } }
            );
        },
    });

    return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

/** Serve a raw stream body verbatim, so a test can end it without a trailing newline. */
function serveRaw(body: string): { url: string; stop: () => void } {
    const server = Bun.serve({
        port: 0,
        fetch() {
            return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
        },
    });

    return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

function chunk(delta: Record<string, string>): string {
    return SafeJSON.stringify({ choices: [{ delta }] });
}

describe("AiProxyClient streaming", () => {
    test("reports reasoning deltas separately from content", async () => {
        // The runner's stall watchdog only ever saw content deltas, so a model that
        // thought for 90s before its first content token was aborted as "no output"
        // while the stream was alive the whole time (2026-07-25, grok-4.5).
        const { url, stop } = serveSse([
            chunk({ reasoning_content: "thinking hard" }),
            chunk({ reasoning: "still thinking" }),
            chunk({ thinking: "nearly there" }),
            chunk({ content: "the answer" }),
        ]);

        const reasoning: string[] = [];
        const text: string[] = [];
        try {
            const result = await new AiProxyClient({ baseUrl: url, apiKey: "test" }).chatStream(
                { model: "test/model", messages: [{ role: "user", content: "hi" }] },
                { onDelta: (d) => text.push(d), onReasoningDelta: (d) => reasoning.push(d) }
            );

            // every provider spelling of the reasoning field counts as progress
            expect(reasoning).toEqual(["thinking hard", "still thinking", "nearly there"]);
            expect(text).toEqual(["the answer"]);
            // reasoning never leaks into the answer
            expect(result.text).toBe("the answer");
        } finally {
            stop();
        }
    });

    test("a stream of pure reasoning still yields no text", async () => {
        const { url, stop } = serveSse([chunk({ reasoning_content: "thought about it" })]);

        const reasoning: string[] = [];
        try {
            const result = await new AiProxyClient({ baseUrl: url, apiKey: "test" }).chatStream(
                { model: "test/model", messages: [{ role: "user", content: "hi" }] },
                { onReasoningDelta: (d) => reasoning.push(d) }
            );

            expect(reasoning).toEqual(["thought about it"]);
            expect(result.text).toBe("");
        } finally {
            stop();
        }
    });

    test("keeps a final frame that arrives without a trailing newline", async () => {
        // The terminal usage / finish_reason chunk is commonly unterminated; the
        // reader used to break on `done` with that frame still sitting in the buffer.
        const tail = SafeJSON.stringify({
            choices: [{ delta: { content: "!" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 },
        });
        const { url, stop } = serveRaw(`data: ${chunk({ content: "hi" })}\n\ndata: ${tail}`);

        try {
            const result = await new AiProxyClient({ baseUrl: url, apiKey: "test" }).chatStream({
                model: "test/model",
                messages: [{ role: "user", content: "hi" }],
            });

            expect(result.text).toBe("hi!");
            expect(result.finishReason).toBe("stop");
            expect(result.usage?.totalTokens).toBe(13);
        } finally {
            stop();
        }
    });
});
