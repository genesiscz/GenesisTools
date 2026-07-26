import { describe, expect, test } from "bun:test";
import { repairJson, stripToJson } from "./repair";

describe("repairJson", () => {
    test("parses strict JSON without repair", () => {
        const res = repairJson('{"a": 1}');
        expect(res.value).toEqual({ a: 1 });
        expect(res.repaired).toBe(false);
        expect(res.error).toBeUndefined();
    });

    test("repairs trailing comma", () => {
        const res = repairJson('{"a": 1,}');
        expect(res.value).toEqual({ a: 1 });
        expect(res.repaired).toBe(true);
    });

    test("repairs single quotes", () => {
        const res = repairJson("{'fruit': 'cherry'}");
        expect(res.value).toEqual({ fruit: "cherry" });
        expect(res.repaired).toBe(true);
    });

    test("repairs truncated array", () => {
        const res = repairJson('{"items":[1,2,3');
        expect(res.value).toEqual({ items: [1, 2, 3] });
        expect(res.repaired).toBe(true);
    });

    test("strips markdown fences and surrounding prose", () => {
        const res = repairJson('Here you go:\n```json\n{"ok": true}\n```\nHope that helps!');
        expect(res.value).toEqual({ ok: true });
    });

    test("pure prose returns error, never a coerced string value", () => {
        const res = repairJson("I cannot answer that in JSON, sorry.");
        expect(res.value).toBeUndefined();
        expect(res.error).toBe("no JSON object/array found in reply");
    });
});

describe("stripToJson", () => {
    test("slices to outermost object", () => {
        expect(stripToJson('noise {"a": {"b": 2}} trailing')).toBe('{"a": {"b": 2}}');
    });

    test("keeps unclosed value from opening bracket", () => {
        expect(stripToJson('prefix [1, 2')).toBe("[1, 2");
    });
});
