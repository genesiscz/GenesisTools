import { describe, expect, it } from "bun:test";
import { createRemainingAnalyzers, remainingAnalyzerConstructors } from "@app/doctor/analyzers/remaining";

describe("remaining analyzer barrel", () => {
    it("exports all ten analyzers in picker order", () => {
        const analyzers = createRemainingAnalyzers();

        expect(analyzers.map((analyzer) => analyzer.id)).toEqual([
            "dev-caches",
            "system-caches",
            "temp-leaks",
            "app-bloat",
            "startup",
            "brew",
            "battery",
            "network",
            "security",
            "extensions",
        ]);
        expect(remainingAnalyzerConstructors).toHaveLength(10);
    });
});
