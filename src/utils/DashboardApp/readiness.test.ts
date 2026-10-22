import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnDetached } from "./detach";
import { isHttpServingStatus, serverErrorExcerpt, waitForReady, waitForUrlReady } from "./readiness";

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

describe("a server that answers with an error", () => {
    test("a page that keeps answering 500 is reported broken, with the body", async () => {
        const server = Bun.serve({
            port: 0,
            fetch: () => Response.json({ status: 500, unhandled: true, message: "HTTPError" }, { status: 500 }),
        });
        try {
            const url = `http://127.0.0.1:${server.port}/`;
            const result = await waitForUrlReady(url, 5_000, { brokenGraceMs: 0 });
            expect(result.ready).toBe(true);
            expect(result.broken?.status).toBe(500);
            expect(result.broken?.body).toContain("HTTPError");
        } finally {
            server.stop(true);
        }
    });

    test("a first 500 that turns into a 200 is ready and not broken", async () => {
        let calls = 0;
        const server = Bun.serve({
            port: 0,
            fetch: () => (calls++ === 0 ? new Response("warming up", { status: 500 }) : new Response("ok")),
        });
        try {
            const result = await waitForUrlReady(`http://127.0.0.1:${server.port}/`, 5_000, { brokenGraceMs: 2_000 });
            expect(result.ready).toBe(true);
            expect(result.broken).toBeUndefined();
        } finally {
            server.stop(true);
        }
    });

    test("the server's error and the top of its stack come from the log, ANSI stripped", () => {
        const logFile = join(tmpdir(), `readiness-excerpt-${process.pid}-${Date.now()}.log`);
        writeFileSync(
            logFile,
            [
                "  VITE v7 ready in 812 ms",
                '\u001b[31mTypeError\u001b[39m: The "paths[0]" property must be of type string, got undefined',
                "    at join (node:path:1:1)",
                "    at /repo/src/utils/logger/daily-trigger.ts:15:55",
                "12:00:01 [vite] page reload",
            ].join("\n")
        );
        try {
            expect(serverErrorExcerpt(logFile)).toEqual([
                'TypeError: The "paths[0]" property must be of type string, got undefined',
                "at join (node:path:1:1)",
                "at /repo/src/utils/logger/daily-trigger.ts:15:55",
            ]);
            expect(serverErrorExcerpt(join(tmpdir(), "no-such-dashboard.log"))).toEqual([]);
            // Bun's own shape, from the real clarity log: header, properties, blank line, stack, then the code frame.
            writeFileSync(
                logFile,
                [
                    "17 | export function startDailyCompressionOnce(logDir: string, today: string): boolean {",
                    "     ^",
                    'TypeError: The "paths[0]" property must be of type string, got undefined',
                    ' code: "ERR_INVALID_ARG_TYPE"',
                    "",
                    "      at join (unknown:1:1)",
                    "      at anonymous (/repo/src/utils/logger/daily-trigger.ts:17:55)",
                    "",
                ].join("\n")
            );
            expect(serverErrorExcerpt(logFile)).toEqual([
                'TypeError: The "paths[0]" property must be of type string, got undefined',
                'code: "ERR_INVALID_ARG_TYPE"',
                "at join (unknown:1:1)",
                "at anonymous (/repo/src/utils/logger/daily-trigger.ts:17:55)",
            ]);
        } finally {
            rmSync(logFile, { force: true });
        }
    });
});
