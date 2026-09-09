import { expect, test } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createFixtureWorld } from "../../src/utils/agent-sessions/testing/fixture-world";
import { withBaseline } from "../../src/utils/agent-sessions/testing/with-baseline";
import { SafeJSON } from "../../src/utils/json";
import { parseSchemaBenchmarkArgs, runSchemaBenchmark } from "./schema-benchmark";

test("requires explicit owned schema-probe paths and session count", () => {
    expect(() => parseSchemaBenchmarkArgs([])).toThrow("--root is required");
    expect(() =>
        parseSchemaBenchmarkArgs(["--root", "relative", "--output", "/tmp/result.json", "--sessions", "2"])
    ).toThrow("--root must be absolute");
    expect(() =>
        parseSchemaBenchmarkArgs(["--root", "/tmp/probe", "--output", "relative.json", "--sessions", "2"])
    ).toThrow("--output must be absolute");
    expect(() =>
        parseSchemaBenchmarkArgs(["--root", "/tmp/probe", "--output", "/tmp/other/result.json", "--sessions", "2"])
    ).toThrow("--output must be inside --root");
    // biome-ignore format: Preserve the assertion snapshot witnessed by the TDD gate.
    expect(
        parseSchemaBenchmarkArgs([
            "--root",
            "/tmp/probe",
            "--output",
            "/tmp/probe/result.json",
            "--sessions",
            "2",
        ])
    ).toEqual({
        root: "/tmp/probe",
        output: "/tmp/probe/result.json",
        sessions: 2,
    });
});

// biome-ignore format: Preserve the smoke-test snapshot witnessed by the TDD gate.
withBaseline(
    "probes legacy and compact metadata storage from one bounded corpus",
    async () => {
        const owner = await createFixtureWorld();
        try {
            const root = join(owner.root, "schema-probe");
            const output = join(root, "result.json");
            await mkdir(root, { recursive: true });

            const report = await runSchemaBenchmark({ root, output, sessions: 2 });
            const persisted = SafeJSON.parse(await readFile(output, "utf8"), { strict: true }) as typeof report;
            // Regression test: frozen schema baseline report — legacy must remain pinned while candidate evolves.
            expect(report.schema).toEqual({
                baselineRevision: "010697b869a34af0e79363b5c74bfc4946f74b96",
                legacy: { sourceKey: false, provider: false },
                candidate: { sourceKey: true, provider: true },
            });

            expect(report.config).toEqual({
                sessions: 2,
                records: 100,
                main: 1,
                subagent: 1,
                seed: 20_260_907,
            });
            expect(report.rows).toEqual({
                legacy: { sessionMetadata: 2, fileIndex: 0 },
                compact: { sessionMetadata: 2, fileIndex: 2 },
            });
            expect(report.parity).toMatchObject({
                fileIdentitiesEqual: true,
                ordinaryMetadataEqual: true,
                fileIdentityCount: 2,
                nativePublicIdDifferenceCount: 1,
            });
            expect(report.parity.fileIdentityHash).toMatch(/^[0-9a-f]{64}$/);
            expect(report.parity.ordinaryMetadataHash).toMatch(/^[0-9a-f]{64}$/);
            expect(report.parity.nativePublicIdDifferenceHash).toMatch(/^[0-9a-f]{64}$/);
            expect(report.storage.legacy.afterCheckpoint.files.wal).toBe(0);
            expect(report.storage.compact.afterCheckpoint.files.wal).toBe(0);
            expect(report.storage.legacy.afterCheckpoint.metadataBytes).toBeGreaterThan(0);
            expect(report.storage.compact.afterCheckpoint.metadataBytes).toBeGreaterThan(0);
            expect(report.storage.compact.afterCheckpoint.totalDerivedBytes).toBeGreaterThan(
                report.storage.compact.afterCheckpoint.metadataBytes
            );
            expect(report.ratios.metadataOnlyCompactToLegacy).toBeGreaterThan(0);
            expect(report.ratios.totalDerivedCompactToLegacy).toBeGreaterThan(0);
            expect(report.mutation).toMatchObject({
                bodyScale: 100,
                metadataEqual: true,
                noBodyCopy: true,
            });
            expect(Math.abs(report.mutation.growthBytes)).toBeLessThanOrEqual(
                report.mutation.allowedPageEffectBytes
            );
            expect(report.sourceCode.changedDuringRun).toEqual([]);
            expect(Object.keys(report.sourceCode.before)).toEqual(Object.keys(report.sourceCode.after));
            expect(persisted.config).toEqual(report.config);
            const serialized = SafeJSON.stringify(report, { strict: true });
            expect(serialized).not.toContain(owner.root);
            expect(serialized).not.toContain("TOOL_BODY_PROBE_SECRET");
            expect(serialized).not.toContain("benchmark-common-term");
        } finally {
            await owner.dispose();
        }
    },
    20_000
);
