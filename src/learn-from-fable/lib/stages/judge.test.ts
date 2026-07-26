import { describe, expect, test } from "bun:test";
import { parseJudgeArray, scoreFromAxes } from "./judge";

describe("parseJudgeArray", () => {
    test("reads a normal batch array", () => {
        const out = parseJudgeArray(
            '[{"id":"a","a1":1,"a2":1,"a3":1,"a4":1,"verdict":"ok"},{"id":"b","a1":0,"a2":0,"a3":0,"a4":0,"verdict":"no"}]'
        );

        expect(out.size).toBe(2);
        expect(out.get("a")?.hard).toBe(1);
        expect(out.get("b")?.soft).toBe(0);
    });

    test("accepts a BARE OBJECT — what a one-item batch actually gets answered with", () => {
        // Real reply, filter run 2026-07-25: the degrade path shrinks a drifting
        // batch toward size 1, and at size 1 the model stops wrapping in an array.
        const out = parseJudgeArray(
            '{"id": "8a4faba3-t663", "a1": 1, "a2": 1, "a3": 1, "a4": 1, "verdict": "Same refactor with tests."}'
        );

        expect(out.size).toBe(1);
        expect(out.get("8a4faba3-t663")?.verdict).toBe("Same refactor with tests.");
    });

    test("skips rows missing an id or with non-numeric axes", () => {
        const out = parseJudgeArray('[{"a1":1,"a2":1,"a3":1,"a4":1},{"id":"c","a1":"x","a2":1,"a3":1,"a4":1}]');

        expect(out.size).toBe(0);
    });

    test("returns empty for prose with no JSON", () => {
        expect(parseJudgeArray("I cannot grade these items.").size).toBe(0);
    });
});

describe("scoreFromAxes", () => {
    test("hard requires a perfect action-class match AND soft >= 0.7", () => {
        expect(scoreFromAxes(1, 1, 1, 1)).toEqual({ hard: 1, soft: 1 });
        expect(scoreFromAxes(0.5, 1, 1, 1).hard).toBe(0);
        expect(scoreFromAxes(1, 0, 0, 0).hard).toBe(0);
    });

    test("clamps out-of-range axes instead of trusting the model", () => {
        expect(scoreFromAxes(5, -2, 1, 1).soft).toBe(scoreFromAxes(1, 0, 1, 1).soft);
    });
});
