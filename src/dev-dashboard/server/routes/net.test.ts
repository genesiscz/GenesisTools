import { describe, expect, test } from "bun:test";
import { checkNetStatusForPort } from "./net";

describe("deriveNetStatus self-ping target", () => {
    test("uses the actually-bound port, not the hardcoded default", async () => {
        const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
        const actualPort = server.port!;

        try {
            const result = await checkNetStatusForPort(actualPort);
            expect(result.quality).not.toBe("down");
        } finally {
            server.stop();
        }
    });
});