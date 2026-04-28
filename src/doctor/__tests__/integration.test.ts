import { describe, expect, it, setDefaultTimeout } from "bun:test";
import { DiskSpaceAnalyzer } from "@app/doctor/analyzers/disk-space";
import { MemoryAnalyzer } from "@app/doctor/analyzers/memory";
import { ProcessesAnalyzer } from "@app/doctor/analyzers/processes";
import { Engine } from "@app/doctor/lib/engine";
import { classifyCachePath, classifyProcess } from "@app/doctor/lib/safety";

setDefaultTimeout(60_000);

describe("integration smoke (dry-run, live machine)", () => {
    it("runs core 3 analyzers without error", async () => {
        const engine = new Engine();
        const errors: string[] = [];

        engine.on("event", (e) => {
            if (e.type === "analyzer-done" && e.error) {
                errors.push(`${e.analyzerId}: ${String(e.error)}`);
            }
        });

        const results = await engine.run([new DiskSpaceAnalyzer(), new MemoryAnalyzer(), new ProcessesAnalyzer()], {
            concurrency: 4,
            thorough: false,
            fresh: true,
            runId: "smoke",
            dryRun: true,
        });

        expect(errors).toEqual([]);
        expect(results.get("memory")?.findings.length).toBeGreaterThan(0);
    });

    it("no non-blocked finding references a blacklisted cache path", async () => {
        const engine = new Engine();
        const results = await engine.run([new DiskSpaceAnalyzer(), new MemoryAnalyzer(), new ProcessesAnalyzer()], {
            concurrency: 4,
            thorough: false,
            fresh: true,
            runId: "smoke",
            dryRun: true,
        });

        for (const result of results.values()) {
            for (const finding of result.findings) {
                const path = typeof finding.metadata?.path === "string" ? finding.metadata.path : null;

                if (path) {
                    const c = classifyCachePath(path);

                    if (c.severity === "blocked") {
                        expect(finding.severity).toBe("blocked");
                    }
                }
            }
        }
    });

    it("no non-blocked finding kills a PROCESS_NEVER_KILL process", async () => {
        const engine = new Engine();
        const results = await engine.run([new ProcessesAnalyzer()], {
            concurrency: 1,
            thorough: false,
            fresh: true,
            runId: "smoke",
            dryRun: true,
        });

        for (const finding of results.get("processes")?.findings ?? []) {
            const comm = typeof finding.metadata?.comm === "string" ? finding.metadata.comm : "";

            if (comm) {
                const c = classifyProcess(comm);

                if (c.severity === "blocked") {
                    expect(finding.severity).toBe("blocked");
                }
            }
        }
    });
});
