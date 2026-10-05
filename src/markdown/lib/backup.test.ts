import { afterAll, describe, expect, it } from "bun:test";
import {
    chmodSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupAndWrite, diffOutcome } from "@app/markdown/lib/backup";

describe("diffOutcome", () => {
    it("reads exit 1 as an ordinary diff, and a failed or cut-off git as a failure", () => {
        expect(diffOutcome({ stdout: "d\n", stderr: "", code: 1, signal: null })).toEqual({ text: "d\n" });
        expect(diffOutcome({ stdout: "", stderr: "fatal: boom\n", code: 128, signal: null }).failure).toBe(
            "git diff exited 128: fatal: boom"
        );
        expect(diffOutcome({ stdout: "", stderr: "", code: 143, signal: "SIGTERM" }).failure).toContain(
            "did not finish"
        );
    });
});

describe("backupAndWrite", () => {
    const dir = mkdtempSync(join(tmpdir(), "md-backup-"));
    const runDir = join(dir, "run");
    mkdirSync(runDir);

    afterAll(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it("keeps a written note and reports a warning when only its manifest line fails", async () => {
        const file = join(dir, "warned.md");
        writeFileSync(file, "before\n");
        const own = join(dir, "warned-run");
        mkdirSync(own);
        mkdirSync(join(own, "manifest.jsonl"));

        const record = await backupAndWrite({
            file,
            before: "before\n",
            after: "after\n",
            runDir: own,
            dryRun: false,
            detail: {},
        });

        expect(readFileSync(file, "utf8")).toBe("after\n");
        expect(readFileSync(record.backup, "utf8")).toBe("before\n");
        expect(record.warning).toContain("the note was written");
    });

    it("keeps a written note and reports a warning when git could not make its patch", async () => {
        const file = join(dir, "no-patch.md");
        writeFileSync(file, "before\n");
        const own = join(dir, "no-patch-run");
        mkdirSync(own);

        const record = await backupAndWrite({
            file,
            before: "before\n",
            after: "after\n",
            runDir: own,
            dryRun: false,
            detail: {},
            diff: async () => ({ text: "", failure: "git diff exited 128: fatal: boom" }),
        });

        expect(readFileSync(file, "utf8")).toBe("after\n");
        expect(record.warning).toContain("the patch is empty or incomplete: git diff exited 128");
        expect(readFileSync(join(own, "manifest.jsonl"), "utf8")).toContain("the patch is empty or incomplete");
    });

    it("refuses to overwrite a note an editor saved while its tokens were resolved", async () => {
        const file = join(dir, "edited.md");
        writeFileSync(file, "saved by the editor\n");

        await expect(
            backupAndWrite({ file, before: "read at start\n", after: "resolved\n", runDir, dryRun: false, detail: {} })
        ).rejects.toThrow("changed on disk");
        expect(readFileSync(file, "utf8")).toBe("saved by the editor\n");
    });

    it("replaces a symlinked note at its target, keeps the copies private, and gives Note.md.patch its own slot", async () => {
        const target = join(dir, "real.md");
        const link = join(dir, "link.md");
        writeFileSync(target, "linked\n");
        symlinkSync(target, link);
        const own = join(dir, "own");
        mkdirSync(own);

        const record = await backupAndWrite({
            file: link,
            before: "linked\n",
            after: "resolved\n",
            runDir: own,
            dryRun: false,
            detail: {},
        });

        expect(lstatSync(link).isSymbolicLink()).toBe(true);
        expect(readFileSync(target, "utf8")).toBe("resolved\n");
        expect(statSync(record.backup).mode & 0o777).toBe(0o600);
        expect(statSync(record.patch).mode & 0o777).toBe(0o600);

        const patchNamed = join(dir, "link.md.patch");
        writeFileSync(patchNamed, "a note\n");
        const second = await backupAndWrite({
            file: patchNamed,
            before: "a note\n",
            after: "b\n",
            runDir: own,
            dryRun: true,
            detail: {},
        });
        expect(second.backup).not.toBe(record.patch);
        expect(readFileSync(record.patch, "utf8")).toContain("+resolved");
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
