import { describe, expect, it, mock } from "bun:test";

/** Capture everything `ui.*` (process.stderr.write) prints during one call. */
async function captureStderr(fn: () => Promise<void>): Promise<string> {
    const writes: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
        writes.push(typeof chunk === "string" ? chunk : String(chunk));
        return true;
    }) as unknown as typeof process.stderr.write;

    try {
        await fn();
    } finally {
        process.stderr.write = orig;
    }

    return writes.join("");
}

// Regression test: #446 item 2 — cmux refusing a caller that was not started
// inside a cmux pane ("Access denied - only processes started inside cmux can
// connect") was misdiagnosed as a dead socket, telling the user to restart cmux.
describe("runDoctor: access-denied verdict", () => {
    it("names the real cause instead of suggesting a restart of cmux", async () => {
        const accessDeniedDetail = "Error: ERROR: Access denied - only processes started inside cmux can connect";

        mock.module("@genesiscz/utils/cmux/lib/health", () => ({
            probeCmuxHealth: async () => ({
                state: "access-denied",
                appPid: 10956,
                appCpu: 0,
                probes: {
                    ping: { ok: false, ms: 21, detail: accessDeniedDetail },
                    capabilities: { ok: false, ms: 15, detail: accessDeniedDetail },
                    identify: { ok: false, ms: 0, detail: "skipped (ping failed)" },
                },
            }),
        }));
        mock.module("@app/cmux/lib/send-self-preflight", () => ({
            probeSelfSend: async () => ({
                ok: false,
                detail: "unknown (identify did not answer)",
                fix: "see the ping/identify lines above",
            }),
        }));

        const { runDoctor } = await import("./doctor");
        const output = await captureStderr(() => runDoctor({}));

        expect(output).toContain("run this from a cmux pane");
        expect(output).not.toContain("restart of cmux is likely required");

        mock.restore();
    });
});
