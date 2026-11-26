import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FableReplaceError } from "./internal";
import { mergeFileEdits, run } from "./sweep-many-files";
import type { FileEdit, RunParams, RunReport, VerifyControl } from "./types";

// The runner's output levels and its new checks: "stat" prints one header line per file with +N -M, a FileEdit's own
// level wins over the run's, absentInChange looks only at the lines the ops added or changed, mergeFileEdits keeps the
// new fields, and the verify control's probe goes into the folder of the first written file. One temp folder. The
// gitMove cases (a staged git rename, its rollback, an untracked file) live in cli-json.test.ts: run() and rollback()
// call git through spawnSync, which runs there in the CLI child and never in this test worker (oven-sh/bun#34069).

type ConsoleMethod = "log" | "info" | "warn" | "error" | "debug";
const CONSOLE_METHODS: ConsoleMethod[] = ["log", "info", "warn", "error", "debug"];

let dir = "";

const put = (rel: string, content: string): string => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    return full;
};

const read = (rel: string): string => fs.readFileSync(path.join(dir, rel), "utf8");

/** Runs `fn` with every console method spied, and returns what it answered and every line the spies saw. */
const captured = async <T>(fn: () => T | Promise<T>): Promise<{ value: T; lines: string[] }> => {
    const spies = CONSOLE_METHODS.map((method) => spyOn(console, method).mockImplementation(() => {}));
    try {
        const value = await fn();
        const lines = spies
            .flatMap((spy) => spy.mock.calls)
            .flatMap((call) => call.map(String).join(" ").split("\n"))
            // biome-ignore lint/suspicious/noControlCharactersInRegex: strips the colour codes run() may print
            .map((line) => line.replace(/\u001b\[[0-9;]*m/g, ""));
        return { value, lines };
    } finally {
        for (const spy of spies) {
            spy.mockRestore();
        }
    }
};

/** run() that must fail: the FableReplaceError and every line printed on the way. */
const failed = async (params: RunParams): Promise<{ error: FableReplaceError; lines: string[] }> => {
    const { value, lines } = await captured(async () => {
        try {
            await run(params);
        } catch (err) {
            if (err instanceof FableReplaceError) {
                return err;
            }

            throw err;
        }

        throw new Error("run() succeeded");
    });
    return { error: value, lines };
};

const literal = (file: string, find: string, replace: string): FileEdit => ({ file, ops: [{ find, replace }] });

const HEADER_STAT = /^(\S+) \((edited|renamed|created|deleted)\) \+(\d+) -(\d+)$/;

beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-output-"));
});

afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("diff levels", () => {
    test('a dry run at "stat" prints one header line per file with +N -M and no diff body', async () => {
        const files = ["stat/one.ts", "stat/two.ts", "stat/three.ts"];
        for (const [i, file] of files.entries()) {
            put(file, `export const value${i} = "old";\nexport const keep${i} = 1;\n`);
        }

        const { value: report, lines } = await captured(() =>
            run({ edits: files.map((file) => literal(file, '"old"', '"new"')), dryRun: true, diff: "stat", cwd: dir })
        );
        const headers = lines.filter((line) => HEADER_STAT.test(line));
        expect(headers).toEqual(files.map((file) => `${file} (edited) +1 -1`));
        expect(lines.some((line) => line.startsWith("@@") || /^[+-] /.test(line))).toBe(false);
        expect(report.files.map((f) => f.diffStat)).toEqual(files.map(() => ({ added: 1, removed: 1 })));
        expect(report.files.every((f) => f.diff === undefined)).toBe(true);
        expect(files.every((file) => read(file).includes('"old"'))).toBe(true);
    });

    test('a file at "full" beside a run at "stat" prints that one diff', async () => {
        put("mixed/full.ts", 'export const shown = "old";\n');
        put("mixed/stat.ts", 'export const counted = "old";\n');
        const { value: report, lines } = await captured(() =>
            run({
                edits: [
                    { ...literal("mixed/full.ts", '"old"', '"new"'), diff: "full" },
                    literal("mixed/stat.ts", '"old"', '"new"'),
                ],
                dryRun: true,
                diff: "stat",
                cwd: dir,
            })
        );
        expect(lines.filter((line) => line.startsWith("@@"))).toEqual(["@@ line 1 (−1 +1) @@"]);
        expect(lines).toContain('+ export const shown = "new";');
        expect(lines.some((line) => line.includes("counted") && /^[+-] /.test(line))).toBe(false);
        expect(lines).toContain("mixed/stat.ts (edited) +1 -1");
        expect(report.files[0].diff).toContain('+ export const shown = "new";');
        expect(report.files[1].diff).toBeUndefined();
    });

    test('unset: a dry run prints the full diff, a real run only the header; "none" drops the dry diff', async () => {
        put("unset/a.ts", "export const a = 1;\n");
        const dry = await captured(() => run({ edits: [literal("unset/a.ts", "= 1", "= 2")], dryRun: true, cwd: dir }));
        expect(dry.lines).toContain("+ export const a = 2;");
        expect(dry.value.files[0].diff).toContain("+ export const a = 2;");

        const none = await captured(() =>
            run({ edits: [literal("unset/a.ts", "= 1", "= 2")], dryRun: true, diff: "none", cwd: dir })
        );
        expect(none.lines.some((line) => line.startsWith("@@"))).toBe(false);
        expect(none.lines).toContain("unset/a.ts (edited)");

        const real = await captured(() => run({ edits: [literal("unset/a.ts", "= 1", "= 2")], cwd: dir }));
        expect(real.lines.some((line) => line.startsWith("@@"))).toBe(false);
        expect(real.value.files[0].diffStat).toEqual({ added: 1, removed: 1 });
        expect(read("unset/a.ts")).toBe("export const a = 2;\n");
    });

    test("an unknown level is a pre-flight refusal (code 2)", async () => {
        put("level/a.ts", "export const a = 1;\n");
        const params = { edits: [literal("level/a.ts", "= 1", "= 2")], dryRun: true, cwd: dir };
        const run1 = await failed({ ...params, diff: "ful" as "full" });
        expect(run1.error.code).toBe(2);
        expect(run1.error.message).toContain('diff "ful" is not a level');
    });
});

describe("absentInChange", () => {
    test("a hit in a changed line fails; the same text on an untouched line passes", async () => {
        put("absent/a.ts", "legacyCall();\nexport const x = 1;\n");
        const hit = await failed({
            edits: [{ ...literal("absent/a.ts", "= 1;", "= legacyCall();"), absentInChange: ["legacyCall("] }],
            dryRun: true,
            cwd: dir,
        });
        expect(hit.error.code).toBe(1);
        const failures = hit.error.report?.files[0].postConditionFailures ?? [];
        expect(failures).toEqual(['absentInChange violated at line 2, a line the ops added or changed: "legacyCall("']);
        expect(hit.lines.some((line) => line.includes("POST absentInChange violated at line 2"))).toBe(true);

        const { value: report } = await captured(() =>
            run({
                edits: [{ ...literal("absent/a.ts", "= 1;", "= 2;"), absentInChange: ["legacyCall("] }],
                cwd: dir,
            })
        );
        expect(report.ok).toBe(true);
        expect(read("absent/a.ts")).toBe("legacyCall();\nexport const x = 2;\n");
    });
});

describe("pre-flight of the new fields", () => {
    test("a rewrite beside another op of its file is refused (code 2), and so is a control without a verify", async () => {
        const content = "export const r = 1;\n";
        put("pre/r.ts", content);
        const expectSha256 = createHash("sha256").update(content, "utf8").digest("hex");
        const rewrite = await failed({
            edits: [
                {
                    file: "pre/r.ts",
                    ops: [
                        { kind: "rewrite", content: "export const r = 2;\n", expectSha256 },
                        { find: "r = 2", replace: "r = 3" },
                    ],
                },
            ],
            dryRun: true,
            cwd: dir,
        });
        expect(rewrite.error.code).toBe(2);
        expect(rewrite.error.message).toContain("a rewrite is the only op of its file, and this edit has 2 ops");

        const control = await failed({
            edits: [literal("pre/r.ts", "= 1", "= 2")],
            verifyControl: { probeName: "probe.txt", probeContent: "x", expectInOutput: "probe.txt" },
            cwd: dir,
        });
        expect(control.error.code).toBe(2);
        expect(control.error.message).toContain("verifyControl without verifyCommand");
        expect(read("pre/r.ts")).toBe(content);
    });
});

describe("mergeFileEdits", () => {
    test("keeps absentInChange (unioned), gitMove (true wins) and the wider diff level", () => {
        const merged = mergeFileEdits(
            [
                { ...literal("m.ts", "a", "b"), absentInChange: ["p"], diff: "stat", gitMove: true, renameTo: "n.ts" },
                { ...literal("m.ts", "c", "d"), absentInChange: ["q", "p"], diff: "none", gitMove: false },
                { ...literal("m.ts", "e", "f"), diff: "full" },
            ],
            { cwd: dir }
        );
        expect(merged).toHaveLength(1);
        expect(merged[0]).toMatchObject({ absentInChange: ["p", "q"], gitMove: true, diff: "full", renameTo: "n.ts" });
        expect(merged[0].ops).toHaveLength(3);
        const plain = mergeFileEdits([literal("o.ts", "a", "b"), literal("o.ts", "c", "d")], { cwd: dir });
        expect(Object.keys(plain[0]).filter((key) => ["absentInChange", "gitMove", "diff"].includes(key))).toEqual([]);
    });
});

describe("the verify control", () => {
    const control: VerifyControl = {
        probeName: "runner-probe.txt",
        probeContent: "probe\n",
        expectInOutput: "runner-probe.txt",
    };

    test("the probe goes into the folder of the first written file: caught there, missed at the cwd root", async () => {
        put("verify/sub/v.ts", "export const v = 1;\n");
        const { value: caught } = await captured(() =>
            run({
                edits: [literal("sub/v.ts", "= 1", "= 2")],
                cwd: path.join(dir, "verify"),
                verifyCommand: "ls sub",
                verifyControl: control,
            })
        );
        expect(caught.verify?.status).toBe("pass");
        expect(caught.verify?.control).toBe("caught");

        const missed = await failed({
            edits: [literal("sub/v.ts", "= 2", "= 3")],
            cwd: path.join(dir, "verify"),
            verifyCommand: "ls",
            verifyControl: control,
        });
        expect(missed.error.code).toBe(3);
        const report: RunReport | undefined = missed.error.report;
        expect(report?.verify?.status).toBe("unknown");
        expect(report?.verify?.control).toBe("missed");
        expect(read("verify/sub/v.ts")).toBe("export const v = 3;\n");
        expect(fs.existsSync(path.join(dir, "verify", "sub", control.probeName))).toBe(false);
    });
});
