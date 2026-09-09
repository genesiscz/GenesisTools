import { describe, expect, test } from "bun:test";
import { closeSync, existsSync, mkdtempSync, openSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openFiles } from "./open-files";

const hasLsof = Bun.which("lsof") !== null || existsSync("/usr/sbin/lsof");

describe("openFiles", () => {
    test("an empty query is a clear answer, not an unknown one", () => {
        expect(openFiles({})).toEqual([]);
    });

    test("paths that do not exist are dropped rather than turned into an lsof error", () => {
        const root = mkdtempSync(join(tmpdir(), "open-files-"));
        expect(openFiles({ files: [join(root, "absent")], directories: [join(root, "absent-dir")] })).toEqual([]);
    });

    test.skipIf(!hasLsof)("finds this process holding its own file open", () => {
        const root = mkdtempSync(join(tmpdir(), "open-files-"));
        const path = join(root, "held.txt");
        writeFileSync(path, "held");
        const handle = openSync(path, "r");

        try {
            const result = openFiles({ files: [path] });
            expect(result).not.toBe("unknown");
            expect(Array.isArray(result) ? result.map((entry) => entry.pid) : []).toContain(process.pid);
        } finally {
            closeSync(handle);
        }
    });

    test.skipIf(!hasLsof)("reports a clear result once the handle is closed", () => {
        const root = mkdtempSync(join(tmpdir(), "open-files-"));
        const path = join(root, "released.txt");
        writeFileSync(path, "released");
        closeSync(openSync(path, "r"));

        expect(openFiles({ files: [path] })).toEqual([]);
    });
});
