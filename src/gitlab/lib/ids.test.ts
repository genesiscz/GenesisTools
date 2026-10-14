import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { assignIds, emptyIdMap, idMapPath, keyOfId, loadIdMap, parseId, saveIdMap } from "./ids";

describe("review ids", () => {
    test("new items get the next numbers; known items keep theirs, in any order", () => {
        const map = emptyIdMap();

        expect(assignIds(map, "T", ["a", "b"])).toEqual(["T01", "T02"]);
        expect(assignIds(map, "T", ["c", "a"])).toEqual(["T03", "T01"]);
        expect(assignIds(map, "F", ["src/a.ts"])).toEqual(["F01"]);
    });

    test("an id parses in its own form and the older lower-case one, and maps back to its key", () => {
        const map = emptyIdMap();
        assignIds(map, "D", ["900", "901"]);

        expect(parseId("D02")).toEqual({ kind: "D", n: 2 });
        expect(parseId("d2")).toEqual({ kind: "D", n: 2 });
        expect(parseId("X1")).toBeNull();
        expect(keyOfId(map, "D02")).toEqual({ kind: "D", key: "901" });
        expect(keyOfId(map, "D09")).toBeNull();
    });

    test("a stored map that does not parse throws instead of starting a new one, and keeps its bytes", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-ids-"));
        const path = idMapPath({ host: "https://gitlab.example.com", project: "group/app", iid: 9 }, dir);
        mkdirSync(dirname(path), { recursive: true });
        const truncated = '{"F": {"src/a.ts": 1}, "T": {"disc-1": 1, "disc-2": 2}, "D": {"90';
        writeFileSync(path, truncated);

        expect(() => loadIdMap(path)).toThrow(`the review id map ${path} cannot be read or does not parse`);
        expect(readFileSync(path, "utf8")).toBe(truncated);

        writeFileSync(path, "[1, 2]");
        expect(() => loadIdMap(path)).toThrow("is not a JSON object");

        // Negative control: a valid map loads with its numbers, and a new thread gets the next free one.
        writeFileSync(path, '{"T": {"disc-1": 1, "disc-2": 2}}');
        expect(assignIds(loadIdMap(path), "T", ["disc-3", "disc-1"])).toEqual(["T03", "T01"]);
    });

    test("invalid saved tables refuse allocation and saving without changing the file", () => {
        const path = join(mkdtempSync(join(tmpdir(), "gt-ids-")), "ids.json");

        for (const invalid of [
            { T: { "disc-1": "broken" } },
            { T: null },
            { F: [] },
            { D: "broken" },
            ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map((n) => ({ Y: { existing: n } })),
            { published: { D01: { draftId: 1 } } },
        ]) {
            const bytes = SafeJSON.stringify(invalid);
            writeFileSync(path, bytes);
            expect(() => {
                const map = loadIdMap(path);
                assignIds(map, "T", ["disc-2"]);
                saveIdMap(path, map);
            }).toThrow("valid id tables");
            expect(readFileSync(path, "utf8")).toBe(bytes);
        }

        writeFileSync(path, '{"T":{"disc-1":7},"published":{"D01":{"draftId":12,"discussionId":"disc-1"}}}');
        const map = loadIdMap(path);
        expect(assignIds(map, "T", ["disc-1", "disc-2"])).toEqual(["T07", "T08"]);
        expect(assignIds(map, "F", ["src/new.ts"])).toEqual(["F01"]);
        expect(map.published?.D01).toEqual({ draftId: 12, discussionId: "disc-1" });
    });

    test("a map survives a save and a load, one file per MR", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-ids-"));
        const path = idMapPath({ host: "https://gitlab.example.com", project: "group/app", iid: 7 }, dir);
        const map = emptyIdMap();
        assignIds(map, "Y", ["d1"]);
        saveIdMap(path, map);

        expect(assignIds(loadIdMap(path), "Y", ["d2", "d1"])).toEqual(["Y02", "Y01"]);
        expect(idMapPath({ host: "https://gitlab.example.com", project: "group/app", iid: 8 }, dir)).not.toBe(path);
    });
});
