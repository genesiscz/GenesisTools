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
});
