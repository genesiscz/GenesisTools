import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { sinceSnapshot } from "./workflow";

function file(contents: string): string {
    const path = join(mkdtempSync(join(tmpdir(), "control-since-")), "previous.json");
    writeFileSync(path, contents);
    return path;
}

const current = {
    snapshot: "tok",
    window: { id: 42 },
    elements: [
        { index: 0, depth: 0, role: "AXWindow", AXTitle: "Calculator" },
        { index: 1, depth: 1, role: "AXStaticText", AXValue: "7" },
    ],
};

describe("sinceSnapshot", () => {
    it("reports what moved against a well-formed previous snapshot", () => {
        const previous = file(
            SafeJSON.stringify({
                window: { id: 42 },
                elements: [
                    { index: 0, depth: 0, role: "AXWindow", AXTitle: "Calculator" },
                    { index: 1, depth: 1, role: "AXStaticText", AXValue: "0" },
                ],
            })
        );
        const result = sinceSnapshot(previous, { ...current });
        expect(result.since).toMatchObject({ comparable: true, previousElements: 2 });
        expect(result.elementCount).toBe(2);
        expect((result.changes as { changed: unknown[] }).changed).toHaveLength(1);
    });

    // The AX walk already happened. Throwing here would discard it to report a bad argument.
    it("keeps the fresh snapshot when the file is missing", () => {
        const result = sinceSnapshot(join(tmpdir(), "control-since-absent", "nope.json"), { ...current });
        expect(result.since).toMatchObject({ comparable: false });
        expect(String((result.since as { reason: string }).reason)).toContain("unreadable");
        expect(result.elements).toEqual(current.elements);
    });

    it("keeps the fresh snapshot when the file is truncated JSON", () => {
        const result = sinceSnapshot(file('{"elements": [{"index": 0,'), { ...current });
        expect(result.since).toMatchObject({ comparable: false });
        expect(result.elements).toEqual(current.elements);
    });

    // `{}` would make previous.elements an empty array and report every current row as added.
    it("refuses to diff against a snapshot with no elements rather than calling everything new", () => {
        const result = sinceSnapshot(file("{}"), { ...current });
        expect(result.since).toMatchObject({ comparable: false });
        expect(String((result.since as { reason: string }).reason)).toContain("elements");
        expect(result.elements).toEqual(current.elements);
    });

    it("refuses a snapshot whose elements are not rows", () => {
        for (const bad of ['{"elements": [null]}', '{"elements": [{"index": "0"}]}', '{"elements": {}}']) {
            const result = sinceSnapshot(file(bad), { ...current });
            expect(result.since).toMatchObject({ comparable: false });
        }
    });

    it("still refuses a different window by id", () => {
        const previous = file(
            SafeJSON.stringify({ window: { id: 7 }, elements: [{ index: 0, depth: 0, role: "AXWindow" }] })
        );
        const result = sinceSnapshot(previous, { ...current });
        expect(String((result.since as { reason: string }).reason)).toContain("different window id");
    });
});
