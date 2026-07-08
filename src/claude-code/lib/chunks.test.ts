import { describe, expect, test } from "bun:test";
import { chunkSetDiff, filterByPatterns, pairChunks, splitChunks } from "./chunks";

const NORM_A = [
    "(function(ID, ID) {",
    "  var ID = 1;",
    "  function ID(ID) {",
    '    return ID("cron_fire");',
    "  }",
    "  var ID = 3;",
    "})",
].join("\n");

const DISPLAY_A = [
    "(function(exports, require) {",
    "  var q1 = 1;",
    "  function fire(cb) {",
    '    return cb("cron_fire");',
    "  }",
    "  var z9 = 3;",
    "})",
].join("\n");

describe("chunks", () => {
    test("splits on top-level declarations and carries display text", () => {
        const chunks = splitChunks(NORM_A, DISPLAY_A);
        expect(chunks.length).toBe(4);
        expect(chunks[1]?.text).toBe("  var ID = 1;\n");
        expect(chunks[1]?.display).toBe("  var q1 = 1;\n");
        expect(chunks[2]?.text).toContain("cron_fire");
    });

    test("chunkSetDiff is move-invariant", () => {
        const a = splitChunks(NORM_A, DISPLAY_A);
        const movedSource = [
            "(function(ID, ID) {",
            "  var ID = 3;",
            "  var ID = 1;",
            "  function ID(ID) {",
            '    return ID("cron_fire");',
            "  }",
            "})",
        ].join("\n");
        const b = splitChunks(movedSource, movedSource);
        const d = chunkSetDiff(a, b);
        expect(d.onlyA.length).toBe(2);
        expect(d.onlyB.length).toBe(2);
        expect(d.sameCount).toBe(2);
    });

    test("filterByPatterns requires ALL patterns in one chunk", () => {
        const chunks = splitChunks(NORM_A, DISPLAY_A);
        expect(filterByPatterns(chunks, [/cron_fire/]).length).toBe(1);
        expect(filterByPatterns(chunks, [/cron_fire/, /var/]).length).toBe(0);
    });

    test("pairChunks matches by shared string literals", () => {
        const a = splitChunks('  var ID = ID("alpha", "beta");\n', '  var x = f("alpha", "beta");\n');
        const b = splitChunks('  var ID = ID("alpha", "beta", "gamma");\n', '  var y = g("alpha", "beta", "gamma");\n');
        const pairs = pairChunks(a, b);
        expect(pairs.length).toBe(1);
        expect(pairs[0]?.a).toBeDefined();
        expect(pairs[0]?.b).toBeDefined();
        expect(pairs[0]?.similarity).toBeGreaterThan(0.5);
    });
});
