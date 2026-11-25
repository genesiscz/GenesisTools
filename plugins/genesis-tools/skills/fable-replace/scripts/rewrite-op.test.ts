import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rollback } from "./backup-and-rollback";
import { applyOps } from "./edit-one-file";
import { FableReplaceError } from "./internal";
import { reportToJson } from "./report-json";
import { parseSpec } from "./spec";
import { run } from "./sweep-many-files";
import type { FileEdit } from "./types";

// A rewrite replaces a whole file without sending the old text back as a needle: the caller names the sha256 of what
// it read, and a file that changed since is a MISS naming the current hash. These tests pin that contract through
// run(), the undo through rollback(), and the two FRSPEC lines of P4 (`<<< rewrite sha256=` and `absent-in-change:`).

const OLD = "# Notes\n\nalpha line\nbeta line\n";
const NEW = "# Notes\n\nalpha line\ngamma line\n";

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** A work folder holding notes.md with OLD, and a separate backup folder beside it. */
const fixture = (): { work: string; backupDir: string; target: string } => {
    const root = mkdtempSync(join(tmpdir(), "fr-rewrite-"));
    const work = join(root, "work");
    mkdirSync(work);
    const target = join(work, "notes.md");
    writeFileSync(target, OLD);
    return { work, backupDir: join(root, "backup"), target };
};

const missOf = async (promise: Promise<unknown>): Promise<FableReplaceError> => {
    try {
        await promise;
    } catch (err) {
        if (err instanceof FableReplaceError) {
            return err;
        }

        throw err;
    }

    throw new Error("run() accepted the batch");
};

describe("the rewrite op through run()", () => {
    test("the right hash writes the body, and rollback() restores the old content", async () => {
        const { work, backupDir, target } = fixture();
        const spec = [`@@ notes.md`, `<<< rewrite sha256=${sha256(OLD)}`, ...NEW.slice(0, -1).split("\n"), ">>>"].join(
            "\n"
        );

        const report = await run({ cwd: work, backupDir, verbose: false, edits: parseSpec({ text: spec, cwd: work }) });

        expect(report.ok).toBe(true);
        expect(report.files[0].action).toBe("edited");
        expect(report.files[0].ops[0].status).toBe("OK");
        expect(report.files[0].ops[0].desc).toBe(`rewrite sha256=${sha256(OLD).slice(0, 12)}…`);
        expect(readFileSync(target, "utf8")).toBe(NEW);

        const undo = rollback({ backupDir });
        expect(undo.restored).toEqual([target]);
        expect(readFileSync(target, "utf8")).toBe(OLD);
    });

    test("a stale hash is a MISS naming the current hash, and nothing is written", async () => {
        const { work, backupDir, target } = fixture();
        const stale = sha256("what the caller read an hour ago\n");

        const failure = await missOf(
            run({
                cwd: work,
                backupDir,
                verbose: false,
                edits: [{ file: "notes.md", ops: [{ kind: "rewrite", content: NEW, expectSha256: stale }] }],
            })
        );

        expect(failure.code).toBe(1);
        const op = failure.report?.files[0].ops[0];
        expect(op?.status).toBe("MISS");
        expect(op?.reason?.startsWith(`current sha256 ${sha256(OLD)}: `)).toBe(true);
        expect(op?.currentSha256).toBe(sha256(OLD));
        expect(reportToJson({ error: failure, dryRun: false }).files[0].ops[0].currentSha256).toBe(sha256(OLD));
        expect(failure.report?.written).toEqual([]);
        expect(readFileSync(target, "utf8")).toBe(OLD);
    });

    test("without a hasher: a dry run without expectSha256 hands back sha256Before, and a real run needs it", async () => {
        const { work, backupDir, target } = fixture();
        const rewrite = (expectSha256?: string): FileEdit[] => [
            { file: "notes.md", ops: [{ kind: "rewrite", content: NEW, expectSha256 }] },
        ];

        const preview = await run({ cwd: work, dryRun: true, verbose: false, edits: rewrite() });
        const [entry] = reportToJson({ report: preview, dryRun: true }).files;
        expect(entry.ops[0].status).toBe("OK");
        expect(entry.sha256Before).toBe(sha256(OLD));
        expect(readFileSync(target, "utf8")).toBe(OLD);

        const refused = await missOf(run({ cwd: work, backupDir, verbose: false, edits: rewrite() }));
        expect(refused.code).toBe(2);
        expect(refused.message).toContain("Dry-run it first, then send that report's sha256Before for this file");
        expect(readFileSync(target, "utf8")).toBe(OLD);

        const landed = await run({ cwd: work, backupDir, verbose: false, edits: rewrite(entry.sha256Before) });
        expect(landed.ok).toBe(true);
        expect(readFileSync(target, "utf8")).toBe(NEW);
    });
});

describe("the rewrite op in applyOps", () => {
    test("an upper-case hash matches, and identical content is an OK that changes nothing", () => {
        const { content, results } = applyOps(OLD, [
            { kind: "rewrite", content: OLD, expectSha256: sha256(OLD).toUpperCase() },
        ]);

        expect(results[0].status).toBe("OK");
        expect(content).toBe(OLD);
    });

    test("a re-sent rewrite says the file already holds the content, and a bad hash names the current one", () => {
        const resent = applyOps(NEW, [{ kind: "rewrite", content: NEW, expectSha256: sha256(OLD) }]).results[0];
        expect(resent.status).toBe("MISS");
        expect(resent.reason).toContain(`current sha256 ${sha256(NEW)}: the file already holds this content`);

        const malformed = applyOps(OLD, [{ kind: "rewrite", content: NEW, expectSha256: "abc" }]).results[0];
        expect(malformed.status).toBe("MISS");
        expect(malformed.reason).toContain(`current sha256 ${sha256(OLD)}: expectSha256 must be 64 hex characters`);
    });

    test("a rewrite beside another op misses and keeps the content, so no op's work is dropped", () => {
        const { content, results } = applyOps(OLD, [
            { find: "alpha", replace: "delta" },
            { kind: "rewrite", content: NEW, expectSha256: sha256(OLD) },
        ]);

        expect(results[1].status).toBe("MISS");
        expect(results[1].reason).toContain("a rewrite is the only op of its file");
        expect(content).toBe(OLD.replace("alpha", "delta"));
    });
});

describe("the FRSPEC lines of P4", () => {
    const hex = sha256(OLD);

    test("<<< rewrite sha256= parses with one body; the content ends with one newline", () => {
        const [edit] = parseSpec({ text: `@@ a.md\n<<< rewrite sha256=${hex.toUpperCase()}\nfirst\nsecond\n>>>` });

        expect(edit.ops).toEqual([
            { kind: "rewrite", content: "first\nsecond\n", expectSha256: hex, label: undefined },
        ]);
    });

    test("a second body, a missing or malformed hash, sha256= on another kind and optional are spec errors", () => {
        expect(() => parseSpec({ text: `@@ a.md\n<<< rewrite sha256=${hex}\none\n===\ntwo\n>>>` })).toThrow(
            /rewrite takes 1 body/
        );
        expect(() => parseSpec({ text: "@@ a.md\n<<< rewrite\none\n>>>" })).toThrow(/rewrite needs sha256=/);
        expect(() => parseSpec({ text: "@@ a.md\n<<< rewrite sha256=abc\none\n>>>" })).toThrow(/64 hex characters/);
        const hashless = '[{"file":"a.md","ops":[{"kind":"rewrite","content":"x"}]}]';
        expect(parseSpec({ text: hashless })[0].ops).toEqual([{ kind: "rewrite", content: "x" }]);
        expect(() => parseSpec({ text: hashless.replace('"x"', '"x","expectSha256":5') })).toThrow(
            /\(rewrite\) needs content as a string, and expectSha256 \(when given\) as a string/
        );
        expect(() => parseSpec({ text: `@@ a.md\n<<< sha256=${hex}\none\n===\ntwo\n>>>` })).toThrow(
            /sha256= only applies to rewrite/
        );
        expect(() => parseSpec({ text: `@@ a.md\n<<< rewrite optional sha256=${hex}\none\n>>>` })).toThrow(
            /rewrite cannot be optional/
        );
    });

    test("absent-in-change: parses to FileEdit.absentInChange, and an empty text is refused", () => {
        const [edit] = parseSpec({
            text: "@@ a.md\nabsent-in-change: oldName(\nabsent: legacy\n<<<\nalpha\n===\nbeta\n>>>",
        });

        expect(edit.absentInChange).toEqual(["oldName("]);
        expect(edit.absentAfter).toEqual(["legacy"]);
        expect(() => parseSpec({ text: "@@ a.md\nabsent-in-change: \n<<<\na\n===\nb\n>>>" })).toThrow(
            /absent-in-change: needs the text/
        );
    });
});
