import { describe, expect, it } from "bun:test";
import { createRemainingAnalyzers, remainingAnalyzerConstructors } from "@app/doctor/analyzers/remaining";

describe("remaining analyzer barrel", () => {
    it("exports all eight analyzers in picker order", () => {
        const analyzers = createRemainingAnalyzers();

        expect(analyzers.map((analyzer) => analyzer.id)).toEqual([
            // cpu-spin joined the barrel with the CPU-hog campaign and leads the
            // picker: a process spinning right now outranks a stale cache.
            "cpu-spin",
            "dev-caches",
            "system-caches",
            "startup",
            "brew",
            "battery",
            "network",
            "security",
        ]);
        expect(remainingAnalyzerConstructors).toHaveLength(8);
    });
});
