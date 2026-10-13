import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { Storage } from "@genesiscz/utils/storage";
import { appendPrepareImportEntry, type StoredEntry } from "./prepare-import";

function entry(id: string): StoredEntry {
    return {
        _id: id,
        _status: "pending",
        workItemId: 123,
        workItemTitle: "Synthetic work item",
        date: "2026-10-01",
        hours: 1,
        timeType: "Development",
        comment: "",
    };
}

let prevHome: string | undefined;
let storage: Storage;

beforeEach(() => {
    prevHome = env.get("GENESIS_TOOLS_HOME");
    env.testing.set("GENESIS_TOOLS_HOME", mkdtempSync(join(tmpdir(), "prepare-import-")));
    storage = new Storage("azure-devops");
});

afterEach(() => {
    if (prevHome === undefined) {
        env.testing.unset("GENESIS_TOOLS_HOME");
    } else {
        env.testing.set("GENESIS_TOOLS_HOME", prevHome);
    }
});

/**
 * `add` went through atomicUpdate, which reads an unusable file as null, so a damaged file of staged,
 * unsubmitted entries became a fresh one-entry file. It must refuse instead and keep the bytes.
 */
describe("appendPrepareImportEntry", () => {
    test.each([
        ["does not parse", '{\n  "name": "week",\n  "entries": [{ "_id": "kept", "workItemId": 1'],
        ["has the wrong shape", '{ "name": "week", "entries": "not a list" }\n'],
    ])("refuses a staged file that %s and leaves its bytes untouched", async (_label, planted) => {
        const path = join(storage.getCacheDir(), "prepare-import", "week.json");
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, planted);

        const add = appendPrepareImportEntry({ storage, fileName: "week", entry: entry("new") });

        await expect(add).rejects.toThrow(path);
        expect(readFileSync(path, "utf8")).toBe(planted);
    });

    test("creates a missing file, then appends to it", async () => {
        await appendPrepareImportEntry({ storage, fileName: "week", entry: entry("first") });
        const saved = await appendPrepareImportEntry({ storage, fileName: "week", entry: entry("second") });

        expect(saved.entries.map((e) => e._id)).toEqual(["first", "second"]);

        const path = join(storage.getCacheDir(), "prepare-import", "week.json");
        const onDisk = SafeJSON.parse(readFileSync(path, "utf8"), { strict: true });
        expect(onDisk.name).toBe("week");
        expect(onDisk.entries).toHaveLength(2);
    });
});
