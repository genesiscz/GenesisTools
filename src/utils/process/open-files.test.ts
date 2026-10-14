import { describe, expect, spyOn, test } from "bun:test";
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

    test.skipIf(process.platform !== "linux")("on Linux /proc answers, with no lsof started", async () => {
        const root = mkdtempSync(join(tmpdir(), "open-files-"));
        const path = join(root, "held.txt");
        writeFileSync(path, "held");
        const handle = openSync(path, "r");
        const child = Bun.spawn(["sleep", "30"], { cwd: root, stdout: "ignore", stderr: "ignore", env: process.env });
        const spawned = spyOn(Bun, "spawnSync");

        try {
            const files = openFiles({ files: [path] });
            const tree = openFiles({ directories: [root] });

            expect(Array.isArray(files) ? files.map((entry) => entry.pid) : files).toContain(process.pid);
            // The child's working directory is inside the tree, as `lsof +D` lists it.
            expect(Array.isArray(tree) ? tree.map((entry) => entry.pid) : tree).toContain(child.pid);
            expect(spawned).not.toHaveBeenCalled();
        } finally {
            spawned.mockRestore();
            closeSync(handle);
            child.kill();
            await child.exited;
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
