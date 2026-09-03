import { describe, expect, test } from "bun:test";
import { readBounded } from "./body";

describe("readBounded", () => {
    test("stops at the cap on a chunked body that declares no length", async () => {
        // The content-length guard alone let this through: `Number("")` is 0,
        // so a chunked response was buffered whole, every interval, forever.
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                for (let i = 0; i < 8; i++) {
                    controller.enqueue(new Uint8Array(64).fill(97));
                }

                controller.close();
            },
        });
        const result = await readBounded(new Response(stream), 100);

        expect(result.truncated).toBe(true);
        expect(result.text).toHaveLength(100);
    });

    test("a declared length over the cap is refused without reading", async () => {
        const response = new Response("x".repeat(50), { headers: { "content-length": "500" } });

        expect(await readBounded(response, 100)).toEqual({ text: "", truncated: true });
    });

    test("a body under the cap comes back whole", async () => {
        expect(await readBounded(new Response("hello"), 100)).toEqual({ text: "hello", truncated: false });
    });
});
