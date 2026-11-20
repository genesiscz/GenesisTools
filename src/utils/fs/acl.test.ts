import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skip } from "@genesiscz/utils/test/skip";
import { aclAllows } from "./acl";

function chmodAcl(entry: string, path: string): void {
    const result = spawnSync("/bin/chmod", ["+a", entry, path], { env: process.env });

    if (result.status !== 0) {
        throw new Error(`chmod +a failed: ${result.stderr}`);
    }
}

describe.skipIf(skip.unlessMac)("aclAllows", () => {
    const scratch = () => mkdtempSync(join(tmpdir(), "acl-test-"));

    it("a folder and a file without a list: false", () => {
        const dir = scratch();
        writeFileSync(join(dir, "file"), "x");

        expect(aclAllows(dir)).toBe(false);
        expect(aclAllows(join(dir, "file"))).toBe(false);
    });

    it("an entry that allows: true, for a folder and for a file", () => {
        const dir = scratch();
        writeFileSync(join(dir, "file"), "x");
        chmodAcl("everyone allow add_file,delete_child", dir);
        chmodAcl("everyone allow write", join(dir, "file"));

        expect(aclAllows(dir)).toBe(true);
        expect(aclAllows(join(dir, "file"))).toBe(true);
    });

    it("an entry that only denies, as a home folder has: false", () => {
        const dir = scratch();
        chmodAcl("everyone deny delete", dir);

        try {
            expect(aclAllows(dir)).toBe(false);
        } finally {
            // The list is removed again: with it the test's temporary folder cannot be deleted.
            spawnSync("/bin/chmod", ["-N", dir], { env: process.env });
        }
    });

    it("reads the list of a symbolic link itself, not of the folder it names", () => {
        const dir = scratch();
        mkdirSync(join(dir, "open"));
        chmodAcl("everyone allow add_file", join(dir, "open"));
        symlinkSync(join(dir, "open"), join(dir, "link"));

        expect(aclAllows(join(dir, "link"))).toBe(false);
    });
});
