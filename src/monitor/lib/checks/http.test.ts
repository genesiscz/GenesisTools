import { describe, expect, test } from "bun:test";
import type { Watcher } from "../types";
import { checkWebsite } from "./http";

/**
 * The scheduler polls forever, so a website check that never touches the
 * response body must still release it. Each case asserts the body is no longer
 * open when the check returns: read or cancelled, never left dangling.
 */
async function probe(config: Watcher["config"], status = 200) {
    let captured: Response | undefined;
    const original = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> => {
        captured = new Response("hello world", { status });

        return captured;
    }) as unknown as typeof fetch;

    try {
        const result = await checkWebsite({ target: "https://a.dev/", config, timeoutMs: 1_000 });

        return { result, response: captured as Response };
    } finally {
        globalThis.fetch = original;
    }
}

function bodyReleased(response: Response): boolean {
    return response.bodyUsed || response.body === null || response.body.locked;
}

/** A 200 whose body stream fails halfway: a connection reset after the headers. */
async function probeUnreadableBody(config: Watcher["config"]) {
    const original = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> => {
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode("hel"));
                controller.error(new Error("The socket connection was closed unexpectedly"));
            },
        });

        return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;

    try {
        return await checkWebsite({ target: "https://a.dev/", config, timeoutMs: 1_000 });
    } finally {
        globalThis.fetch = original;
    }
}

describe("checkWebsite", () => {
    test("releases the body on the plain up path", async () => {
        const { result, response } = await probe({});

        expect(result.status).toBe("up");
        expect(bodyReleased(response)).toBe(true);
    });

    test("releases the body on the bad-status path", async () => {
        const { result, response } = await probe({}, 503);

        expect(result.status).toBe("down");
        expect(bodyReleased(response)).toBe(true);
    });

    test("releases the body on the degraded path", async () => {
        const { result, response } = await probe({ degradedAboveMs: -1 });

        expect(result.status).toBe("degraded");
        expect(bodyReleased(response)).toBe(true);
    });

    test("expectBody still reads the body", async () => {
        const { result, response } = await probe({ expectBody: "hello" });

        expect(result.status).toBe("up");
        expect(response.bodyUsed).toBe(true);
    });

    test("a body that fails mid-read is down, not a thrown check", async () => {
        // Without the try/catch around `response.text()` this rejection escapes
        // checkWebsite, and the watcher only ever shows "check failed: …".
        const result = await probeUnreadableBody({ expectBody: "hello" });

        expect(result.status).toBe("down");
        expect(result.httpStatus).toBe(200);
        expect(result.detail).toContain("the body could not be read");
    });
});
