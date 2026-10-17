import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as coverage from "@app/cmux/lib/journal-coverage-live";
import * as selfSend from "@app/cmux/lib/send-self-preflight";
import { journalCoverage } from "@genesiscz/utils/cmux/journal-coverage";
import * as health from "@genesiscz/utils/cmux/lib/health";
import * as readers from "@genesiscz/utils/fs/read-lines";

const originalExitCode = process.exitCode;
afterEach(() => {
    mock.restore();
    process.exitCode = originalExitCode;
});

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

        spyOn(health, "probeCmuxHealth").mockResolvedValue({
            state: "access-denied",
            appPid: 10956,
            appCpu: 0,
            probes: {
                ping: { ok: false, ms: 21, detail: accessDeniedDetail },
                capabilities: { ok: false, ms: 15, detail: accessDeniedDetail },
                identify: { ok: false, ms: 0, detail: "skipped (ping failed)" },
            },
        });
        spyOn(selfSend, "probeSelfSend").mockResolvedValue({
            ok: false,
            detail: "unknown (identify did not answer)",
            fix: "see the ping/identify lines above",
        });
        const journal = spyOn(coverage, "liveJournalCoverage");

        const { runDoctor } = await import("./doctor");
        const output = await captureStderr(() => runDoctor({}));

        expect(output).toContain("run this from a cmux pane");
        expect(output).not.toContain("restart of cmux is likely required");
        expect(output).toContain("not checked (cmux is not healthy: access-denied)");
        expect(output).not.toContain("the live tabs could not be read");
        expect(journal).not.toHaveBeenCalled();
    });
});

describe("runDoctor: surface journal coverage", () => {
    const healthy = async (): Promise<health.CmuxHealth> => ({
        state: "healthy",
        appPid: 4242,
        appCpu: 0,
        probes: {
            ping: { ok: true, ms: 2 },
            capabilities: { ok: true, ms: 2 },
            identify: { ok: true, ms: 3 },
        },
    });

    it("prints how many live tabs the journal knows and how many agent tabs it misses", async () => {
        spyOn(health, "probeCmuxHealth").mockImplementation(healthy);
        spyOn(selfSend, "probeSelfSend").mockResolvedValue({ ok: true, detail: "ok" });
        spyOn(coverage, "liveJournalCoverage").mockResolvedValue({
            tabs: 14,
            recorded: 12,
            agentTabs: 5,
            unrecordedAgentTabs: ["surface:3", "surface:9"],
        });

        const { runDoctor } = await import("./doctor");
        const output = await captureStderr(() => runDoctor({}));

        expect(output).toContain("12 of 14 live tabs have a surface-journal record; 2 of 5 agent tabs have none");
    });

    it("reports an unreadable journal as not checked instead of zero coverage", async () => {
        spyOn(health, "probeCmuxHealth").mockImplementation(healthy);
        spyOn(selfSend, "probeSelfSend").mockResolvedValue({ ok: true, detail: "ok" });
        spyOn(readers, "readLinesBackwardSync").mockImplementation(() => {
            throw Object.assign(new Error("fixture journal permission denied"), { code: "EACCES" });
        });
        spyOn(coverage, "liveJournalCoverage").mockImplementation(async () =>
            journalCoverage({
                refsPath: import.meta.path,
                tabs: [{ surfaceId: "surface-1", agent: true }],
            })
        );

        const { runDoctor } = await import("./doctor");
        const output = await captureStderr(() => runDoctor({}));
        expect(output).toContain("not checked (the surface journal could not be read)");
        expect(output).not.toContain("0 of 1 live tab");
    });

    it("says the journal was not checked when cmux cannot list its tabs, and still prints the rest", async () => {
        spyOn(health, "probeCmuxHealth").mockImplementation(healthy);
        spyOn(selfSend, "probeSelfSend").mockResolvedValue({ ok: true, detail: "ok" });
        spyOn(coverage, "liveJournalCoverage").mockRejectedValue(new Error("cmux tree failed (1): fixture"));

        const { runDoctor } = await import("./doctor");
        const output = await captureStderr(() => runDoctor({}));

        expect(output).toContain("not checked (the live tabs could not be read)");
        expect(output).toContain("healthy");
    });
});
