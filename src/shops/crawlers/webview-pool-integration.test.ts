import { afterAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { detectBunCapabilities } from "@app/utils/bun";
import { WebViewPool } from "@app/utils/WebView";

const caps = detectBunCapabilities();
const maybeIt = caps.headlessBrowser ? it : it.skip;

describe("WebViewPool integration (Alza-style bulk walk)", () => {
    if (!caps.headlessBrowser) {
        it.skip("skipped: Bun lacks headless browser support — no Bun.WebView available", () => {
            // noop
        });
        return;
    }

    const fixture = readFileSync(
        join(import.meta.dir, "..", "api", "shops", "__fixtures__", "alza", "evaluate-product-data.json"),
        "utf8"
    );
    const html = `<!doctype html><html><head><title>fixture</title></head><body>${fixture}</body></html>`;
    // Ephemeral port (0) — Bun.serve assigns a free port; `server.port` is set once serve() returns.
    const server = Bun.serve({
        port: 0,
        fetch(_req: Request): Response {
            return new Response(html, {
                status: 200,
                headers: { "content-type": "text/html; charset=utf-8" },
            });
        },
    });
    const serverPort = server.port;
    afterAll(() => {
        server.stop();
    });

    maybeIt(
        "acquires 4 instances in parallel and releases all on completion",
        async () => {
            const pool = new WebViewPool({
                size: 4,
                instanceOptions: { dataStore: "ephemeral", width: 800, height: 600 },
            });

            try {
                const tasks = Array.from({ length: 8 }, (_, i) => i);
                const titles = await Promise.all(
                    tasks.map((i) =>
                        pool.withInstance(async (wv) => {
                            await wv.navigate(`http://localhost:${serverPort}/?i=${i}`, { timeoutMs: 10_000 });
                            return wv.evaluate<string>("document.title", { timeoutMs: 5_000 });
                        })
                    )
                );

                expect(titles).toHaveLength(8);
                for (const t of titles) {
                    expect(typeof t).toBe("string");
                }

                expect(pool.inUse).toBe(0);
            } finally {
                await pool.drain();
            }

            expect(pool.idle).toBe(0);
            expect(pool.inUse).toBe(0);
        },
        { timeout: 60_000 }
    );

    maybeIt(
        "releases instance when fn throws",
        async () => {
            const pool = new WebViewPool({ size: 2 });
            try {
                await expect(
                    pool.withInstance(async () => {
                        throw new Error("boom");
                    })
                ).rejects.toThrow("boom");
                expect(pool.inUse).toBe(0);
            } finally {
                await pool.drain();
            }
        },
        { timeout: 30_000 }
    );

    maybeIt(
        "respects size cap — 5th task waits for an earlier release",
        async () => {
            const pool = new WebViewPool({ size: 4 });
            let peakInUse = 0;
            try {
                await Promise.all(
                    Array.from({ length: 5 }, (_, i) =>
                        pool.withInstance(async (wv) => {
                            peakInUse = Math.max(peakInUse, pool.inUse);
                            await wv.navigate(`http://localhost:${serverPort}/?slow=${i}`, { timeoutMs: 10_000 });
                            return null;
                        })
                    )
                );
                expect(peakInUse).toBeLessThanOrEqual(4);
            } finally {
                await pool.drain();
            }
        },
        { timeout: 60_000 }
    );
});
