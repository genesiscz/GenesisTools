import { describe, expect, it } from "bun:test";
import { createRemainingAnalyzers, remainingAnalyzerConstructors } from "@app/doctor/analyzers/remaining";

describe("remaining analyzer barrel", () => {
    it("exports all seven Phase 4 analyzers in picker order", () => {
        const analyzers = createRemainingAnalyzers();

        expect(analyzers.map((analyzer) => analyzer.id)).toEqual([
            "dev-caches",
            "system-caches",
            "startup",
            "brew",
            "battery",
            "network",
            "security",
        ]);
        expect(remainingAnalyzerConstructors).toHaveLength(7);
    });
});
