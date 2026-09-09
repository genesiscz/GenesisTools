import { expect } from "bun:test";
import { join } from "node:path";
import { createFixtureWorld } from "@genesiscz/utils/agent-sessions/testing/fixture-world";
import { withBaseline } from "@genesiscz/utils/agent-sessions/testing/with-baseline";
import { createBaselineBenchmarkVariant, runGeneratedHistoryBenchmark } from "./benchmark";
import { createBenchmarkVariant } from "./compact-candidate";

withBaseline(
    "runs the compact HistoryService candidate against a bounded generated corpus",
    async () => {
        const owner = await createFixtureWorld();
        try {
            const root = join(owner.root, "candidate-smoke");
            const artifact = await runGeneratedHistoryBenchmark({
                config: {
                    root,
                    output: join(root, "result.json"),
                    sessionCount: 20,
                    recordCount: 200,
                    mainSessionCount: 10,
                    subagentSessionCount: 10,
                    seed: 20_260_907,
                    warmRepetitions: 1,
                    coldRepetitions: 0,
                },
                async createVariants(context) {
                    return [createBaselineBenchmarkVariant(context), await createBenchmarkVariant(context)];
                },
                includeCli: false,
            });

            expect(artifact.matrix.comparisonStatus).toBe("compared");
            expect(artifact.matrix.prewarm).toEqual([]);
            expect(
                artifact.matrix.measurements.some(
                    (measurement) => measurement.phase === "warm-cli" || measurement.phase === "cold-cli"
                )
            ).toBe(false);
            expect(
                artifact.matrix.measurements.filter((measurement) => measurement.variant === "candidate")
            ).toHaveLength(6);
            expect(
                artifact.matrix.measurements
                    .filter((measurement) => measurement.variant === "candidate")
                    .every((measurement) => measurement.exitStatus === 0)
            ).toBe(true);
            expect(
                artifact.matrix.parity.every(
                    (comparison) => comparison.equalIds && comparison.equalStructure && comparison.equalValues
                )
            ).toBe(true);
            expect(artifact.variantManifests.candidate).toMatchObject({
                engine: "HistoryService",
                providerId: "anthropic-sub",
                database: "compact",
                serviceOnly: true,
                cliMeasurements: false,
                sourceCode: { revision: expect.stringMatching(/^[0-9a-f]{40}$/) },
            });
            const manifest = artifact.variantManifests.candidate as {
                sourceCode: { hashes: Record<string, string> };
            };
            expect(Object.keys(manifest.sourceCode.hashes)).toHaveLength(20);
            expect(Object.values(manifest.sourceCode.hashes).every((hash) => /^[0-9a-f]{64}$/.test(hash))).toBe(true);
        } finally {
            await owner.dispose();
        }
    },
    120_000
);
