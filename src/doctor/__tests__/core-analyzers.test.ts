import { describe, expect, it } from "bun:test";
import { coreAnalyzerConstructors, createCoreAnalyzers } from "@app/doctor/analyzers/core";

describe("core analyzers", () => {
    it("exports the core analyzer constructors in doctor order", () => {
        expect(coreAnalyzerConstructors.map((AnalyzerCtor) => new AnalyzerCtor().id)).toEqual([
            "disk-space",
            "memory",
            "processes",
        ]);
    });

    it("creates fresh analyzer instances", () => {
        const first = createCoreAnalyzers();
        const second = createCoreAnalyzers();
        expect(first.map((analyzer) => analyzer.id)).toEqual(["disk-space", "memory", "processes"]);
        expect(first[0]).not.toBe(second[0]);
    });
});
