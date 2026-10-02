import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupAndWrite } from "@app/markdown/lib/backup";

describe("backupAndWrite", () => {
    const dir = mkdtempSync(join(tmpdir(), "md-backup-"));
    const runDir = join(dir, "run");
    mkdirSync(runDir);

    afterAll(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it("refuses to overwrite a note an editor saved while its tokens were resolved", async () => {
        const file = join(dir, "edited.md");
        writeFileSync(file, "saved by the editor\n");

        await expect(
            backupAndWrite({ file, before: "read at start\n", after: "resolved\n", runDir, dryRun: false, detail: {} })
        ).rejects.toThrow("changed on disk");
        expect(readFileSync(file, "utf8")).toBe("saved by the editor\n");
    });

    it("writes a note that did not change, and a dry run names its proposal", async () => {
        const file = join(dir, "note.md");
        writeFileSync(file, "before\n");

        const record = await backupAndWrite({
            file,
            before: "before\n",
            after: "after\n",
            runDir,
            dryRun: false,
            detail: {},
        });
        expect(readFileSync(file, "utf8")).toBe("after\n");
        expect(record.proposal).toBeUndefined();

        // A private note stays private through the atomic replace.
        chmodSync(file, 0o600);
        await backupAndWrite({ file, before: "after\n", after: "private\n", runDir, dryRun: false, detail: {} });
        expect(statSync(file).mode & 0o777).toBe(0o600);
        writeFileSync(file, "after\n");

        const dry = await backupAndWrite({
            file,
            before: "after\n",
            after: "again\n",
            runDir,
            dryRun: true,
            detail: {},
        });
        expect(readFileSync(file, "utf8")).toBe("after\n");
        expect(dry.proposal).toBe(`${dry.backup}.proposed`);
        expect(readFileSync(dry.proposal ?? "", "utf8")).toBe("again\n");
    });
});
