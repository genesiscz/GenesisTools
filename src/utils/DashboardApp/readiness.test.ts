import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnDetached } from "./detach";
import { isHttpServingStatus, waitForReady } from "./readiness";

describe("isHttpServingStatus", () => {
    test("accepts 2xx–4xx", () => {
        expect(isHttpServingStatus(200)).toBe(true);
        expect(isHttpServingStatus(404)).toBe(true);
    });

    test("rejects gateway-unavailable statuses", () => {
        expect(isHttpServingStatus(502)).toBe(false);
        expect(isHttpServingStatus(503)).toBe(false);
        expect(isHttpServingStatus(504)).toBe(false);
    });
});

function freePort(): number {
    const server = Bun.serve({ port: 0, fetch: () => new Response("") });
    const port = server.port;
    server.stop(true);

    if (port === undefined) {
        throw new Error("Bun.serve did not report a port");
    }

    return port;
}

describe("waitForReady with a detached child", () => {
    test("ends at once when the child exits, not at the 30 s deadline", async () => {
        const logFile = join(tmpdir(), `readiness-exit-${process.pid}-${Date.now()}.log`);
        const { exited } = spawnDetached({ cmd: ["sh", "-c", "exit 3"], logFile });
        const childExit = new AbortController();
        exited.then(({ code }) => childExit.abort(new Error(`child exited (code ${code})`)));

        const started = Date.now();
        const result = await waitForReady({ kind: "http" }, { port: freePort(), logFile, signal: childExit.signal });

        expect(result).toEqual({ ready: false, detail: "child exited (code 3)" });
        expect(Date.now() - started).toBeLessThan(5_000);
    });

    test("a live child is still waited for until it serves", async () => {
        const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
        const alive = new AbortController();

        try {
            const result = await waitForReady(
                { kind: "http" },
                { port: server.port ?? 0, logFile: "", signal: alive.signal }
            );
            expect(result).toEqual({ ready: true, detail: "http 200" });
        } finally {
            server.stop(true);
        }
    });
});
