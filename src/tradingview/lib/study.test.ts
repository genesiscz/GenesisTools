import { describe, expect, test } from "bun:test";
import { buildStudyValues, coerceInputValue, parseInputFlags } from "./study";
import type { StudyMeta } from "./types";

const META: StudyMeta = {
    pineId: "STD;RSI",
    pineVersion: "last",
    description: "Relative Strength Index",
    shortDescription: "RSI",
    ilTemplate: "IL_BLOB",
    inputs: [
        { id: "in_0", name: "Length", type: "integer", defval: 14 },
        { id: "in_1", name: "Source", type: "source", defval: "close", options: ["open", "close"] },
    ],
    plots: [{ id: "plot_0", type: "line", title: "RSI" }],
};

describe("parseInputFlags", () => {
    test("parses k=v pairs", () => {
        expect(parseInputFlags(["Length=21", "Source=open"])).toEqual({ length: "21", source: "open" });
    });

    test("rejects malformed pairs", () => {
        expect(() => parseInputFlags(["Length"])).toThrow(/expected name=value/);
    });
});

describe("coerceInputValue", () => {
    test("coerces by pine input type", () => {
        expect(coerceInputValue("21", "integer")).toBe(21);
        expect(coerceInputValue("0.5", "float")).toBe(0.5);
        expect(coerceInputValue("true", "bool")).toBe(true);
        expect(coerceInputValue("close", "source")).toBe("close");
    });

    test("throws on non-numeric integer", () => {
        expect(() => coerceInputValue("abc", "integer")).toThrow(/not a valid integer/);
    });
});

describe("buildStudyValues", () => {
    test("defaults + overrides + carriers", () => {
        const v = buildStudyValues(META, { length: "21" });
        expect(v.text).toBe("IL_BLOB");
        expect(v.pineId).toBe("STD;RSI");
        expect(v.pineVersion).toBe("last");
        expect(v.in_0).toEqual({ v: 21, f: true, t: "integer" });
        expect(v.in_1).toEqual({ v: "close", f: true, t: "source" });
    });

    test("unknown input name throws with the available names", () => {
        expect(() => buildStudyValues(META, { bogus: "1" })).toThrow(/Length, Source/);
    });
});
