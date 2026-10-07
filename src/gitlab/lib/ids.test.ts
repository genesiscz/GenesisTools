import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
