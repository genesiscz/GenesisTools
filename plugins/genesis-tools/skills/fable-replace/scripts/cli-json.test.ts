import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ReconReport, RunReportJson } from "./types";

// The CLI's JSON doors through the real CLI: --edits - with --json answers one JSON object on stdout (and nothing else
// on either stream), a MISS is ok false with its reason, --quiet alone gives the stat level, --find answers a ReconReport,
// and --rename-module - renames a symbol, its file and every import in a git fixture as one staged git rename, which
// --rollback undoes. The gitMove cases live here and not in runner-output.test.ts, so git runs in the CLI child and
// never through spawnSync in this test worker (oven-sh/bun#34069). Six bun spawns and one git fixture repo; every
// child is awaited.

const CLI = path.join(import.meta.dir, "cli.ts");
const SESSION_KEYS = [
    "CLAUDE_CODE_SESSION_ID",
    "CODEX_THREAD_ID",
    "GROK_SESSION_ID",
    "FABLE_REPLACE_SESSION",
    "FABLE_REPLACE_HARNESS",
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
];
const USE_TS = 'import { Foo } from "./Foo";\n\nexport const made = new Foo();\n';

interface Child {
    status: number;
    stdout: string;
    stderr: string;
}

let base = "";
let env: NodeJS.ProcessEnv = {};

const put = (rel: string, content: string): void => {
    const full = path.join(base, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
};

const read = (rel: string): string => fs.readFileSync(path.join(base, rel), "utf8");

const spawn = async (argv: string[], { cwd, stdin }: { cwd: string; stdin?: string }): Promise<Child> => {
    const proc = Bun.spawn(argv, {
        cwd,
        stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
        env,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 30_000,
    });
    const [stdout, stderr, status] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    return { status, stdout, stderr };
};

const cli = (args: string[], options: { cwd: string; stdin?: string }): Promise<Child> =>
    spawn([process.execPath, CLI, ...args], options);

/** The run report of a --json call: stdout must be exactly one JSON object, or the parse throws. */
const reportOf = (child: Child): RunReportJson => JSON.parse(child.stdout);

/** The CLI's backup folders (cli-*) under `dir` that hold nothing. */
const emptyBackupDirs = (dir: string): string[] => {
    if (!fs.existsSync(dir)) {
        return [];
    }

    return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .flatMap((entry) => {
            const full = path.join(dir, entry.name);
            return entry.name.startsWith("cli-") && fs.readdirSync(full).length === 0 ? [full] : emptyBackupDirs(full);
        });
};

beforeAll(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "cli-json-"));
    env = {
        ...process.env,
        NO_COLOR: "1",
        FABLE_REPLACE_HOME: path.join(base, "home"),
        FABLE_REPLACE_SCRATCH_ROOT: path.join(base, "scratch"),
    };
    for (const key of SESSION_KEYS) {
        delete env[key];
    }
});

afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true });
});

describe("--edits - --json", () => {
    test("a find cannot invoke housekeeping and a JSON find preserves slash literals and comma roots", async () => {
        put("find,a/a.ts", "const a = '/utils/(old)';\n");
        const input = { pattern: "/utils/(old)", roots: ["find,a"] };
        const found = await cli(["--find-json", "-", "--json", "--cwd", base], {
            cwd: base,
            stdin: JSON.stringify(input),
        });
        expect(found.status).toBe(0);
        expect(JSON.parse(found.stdout)).toMatchObject({ pattern: "/utils/(old)", total: 1 });
        const refused = await cli(["--find", "a", "--prune"], { cwd: base });
        expect(refused.status).toBe(2);
        expect(refused.stderr).toContain("Nothing was done");
        const literal = await cli(["--find", "--json", "--cwd", path.join(base, "find,a")], { cwd: base });
        expect(literal.status).toBe(0);
        expect(literal.stdout).toContain("--json:");
    });

    test("a dry literal edit answers one JSON object with ok true, and a report over 64 KB parses whole", async () => {
        put("edits/a.ts", "const x = 1;\n");
        put("edits/big.ts", `export const big = "${"a".repeat(70_000)}";\n`);
        const edits = [
            { file: "a.ts", ops: [{ find: "x", replace: "y" }] },
            { file: "big.ts", ops: [{ find: "const big", replace: "const large" }] },
        ];
        const child = await cli(["--edits", "-", "--json", "--dry", "--cwd", path.join(base, "edits")], {
            cwd: base,
            stdin: JSON.stringify(edits),
        });

        expect(child.status).toBe(0);
        expect(child.stdout.length).toBeGreaterThan(64 * 1024);
        const report = reportOf(child);
        expect(report).toMatchObject({ v: 1, ok: true, exitCode: 0, dryRun: true, missCount: 0, written: [] });
        expect(report.files[0].ops[0].status).toBe("OK");
        expect(report.files[1].diff?.length).toBeGreaterThan(140_000);
        expect(child.stderr).toBe("");
        expect(read("edits/a.ts")).toBe("const x = 1;\n");
    });

    test("an absent needle is ok false with exit 1 and its reason; --quiet alone gives each file a stat and no diff", async () => {
        put("edits/a.ts", "const x = 1;\n");
        put("edits/b.ts", "const b = 1;\n");
        const edits = [
            { file: "a.ts", ops: [{ find: "absent-needle", replace: "y" }] },
            { file: "b.ts", ops: [{ find: "b = 1", replace: "b = 2" }] },
        ];
        const child = await cli(["--edits", "-", "--json", "--dry", "--quiet", "--cwd", path.join(base, "edits")], {
            cwd: base,
            stdin: JSON.stringify(edits),
        });

        expect(child.status).toBe(1);
        const report = reportOf(child);
        expect(report).toMatchObject({ ok: false, exitCode: 1, missCount: 1 });
        const [missed, kept] = report.files;
        expect(missed.ops[0].status).toBe("MISS");
        expect(missed.ops[0].reason).toContain("needle not found");
        expect(kept.diffStat).toEqual({ added: 1, removed: 1 });
        expect(kept.diff).toBeUndefined();
        expect(child.stderr).toBe("");
    });

    test("an op whose find equals its replace is NOOP, not MISS, and the batch still writes nothing", async () => {
        put("edits/c.ts", "const c = 1;\n");
        const edits = [
            { file: "c.ts", ops: [{ find: "c = 1", replace: "c = 1" }] },
            { file: "a.ts", ops: [{ find: "const x = 1;", replace: "const x = 2;" }] },
        ];
        const child = await cli(["--edits", "-", "--json", "--cwd", path.join(base, "edits")], {
            cwd: base,
            stdin: JSON.stringify(edits),
        });

        expect(child.status).toBe(1);
        const report = reportOf(child);
        expect(report).toMatchObject({ ok: false, exitCode: 1, missCount: 1, written: [] });
        expect(report.files[0].ops[0]).toMatchObject({
            status: "NOOP",
            found: 1,
            reason: "find === replace (no-op edit)",
        });
        expect(read("edits/a.ts")).toBe("const x = 1;\n");
    });

    test("a refusal (input that is not JSON) is a report with exit 2, and nothing else is printed", async () => {
        const child = await cli(["--edits", "-", "--json", "--cwd", path.join(base, "edits")], {
            cwd: base,
            stdin: "{not json",
        });

        expect(child.status).toBe(2);
        expect(child.stderr).toBe("");
        const report = reportOf(child);
        expect(report).toMatchObject({ ok: false, exitCode: 2 });
        expect(report.error).toContain("the input is not JSON");
    });

    test("every op carries expected and lines as data, on a count mismatch MISS and on an OK alike", async () => {
        put("edits/count.ts", "const Bar = 1; Bar;\nconst x = 2;\n\nBar();\n");
        const edits = [
            {
                file: "count.ts",
                ops: [
                    { find: "Bar", replace: "Baz" },
                    { find: "const x = 2", replace: "const x = 3" },
                ],
            },
        ];
        const child = await cli(["--edits", "-", "--json", "--dry", "--cwd", path.join(base, "edits")], {
            cwd: base,
            stdin: JSON.stringify(edits),
        });

        expect(child.status).toBe(1);
        const [missed, kept] = reportOf(child).files[0].ops;
        expect(missed).toMatchObject({ status: "MISS", found: 3, expected: 1, lines: [1, 1, 4] });
        expect(missed.reason).toContain("expected exactly 1 occurrence(s), found 3 at line(s) 1, 1, 4");
        expect(kept).toMatchObject({ status: "OK", found: 1, expected: 1, lines: [2] });
    });

    test("a real run that writes nothing reports no backupDir and leaves no empty backup folder; a refused file is data", async () => {
        put("edits/whole.ts", "export const whole = 1;\n");
        const refusedRun = await cli(["--edits", "-", "--json", "--cwd", path.join(base, "edits")], {
            cwd: base,
            stdin: JSON.stringify([
                { file: "whole.ts", ops: [{ kind: "rewrite", content: "export const whole = 2;\n" }] },
            ]),
        });
        const missRun = await cli(["--edits", "-", "--json", "--cwd", path.join(base, "edits")], {
            cwd: base,
            stdin: JSON.stringify([{ file: "whole.ts", ops: [{ find: "absent-needle", replace: "y" }] }]),
        });

        expect(refusedRun.status).toBe(2);
        const refused = reportOf(refusedRun);
        expect(refused).toMatchObject({ ok: false, exitCode: 2, written: [] });
        expect(refused.files).toEqual([
            {
                file: "whole.ts",
                action: "refused",
                reason: expect.stringContaining("a rewrite needs expectSha256 on a real run"),
                ops: [],
                postConditionFailures: [],
            },
        ]);
        expect(missRun.status).toBe(1);
        const miss = reportOf(missRun);
        expect(miss).toMatchObject({ ok: false, exitCode: 1, written: [] });
        expect(["backupDir" in refused, "backupDir" in miss]).toEqual([false, false]);
        expect(emptyBackupDirs(path.join(base, "scratch"))).toEqual([]);
        expect(read("edits/whole.ts")).toBe("export const whole = 1;\n");
    });

    test("a deleted file is a plain path in written, and its action says it was deleted", async () => {
        put("edits/gone.ts", "export const gone = 1;\n");
        const child = await cli(["--edits", "-", "--json", "--cwd", path.join(base, "edits")], {
            cwd: base,
            stdin: JSON.stringify([{ file: "gone.ts", delete: true }]),
        });

        expect(child.status).toBe(0);
        const report = reportOf(child);
        expect(report).toMatchObject({
            ok: true,
            written: ["gone.ts"],
            files: [{ file: "gone.ts", action: "deleted" }],
        });
        expect(fs.existsSync(path.join(base, "edits", "gone.ts"))).toBe(false);
    });
});

describe("a git fixture: --find, --rename-module, --rollback and an untracked gitMove", () => {
    let repo = "";
    let backupDir = "";

    const git = async (...args: string[]): Promise<string> => {
        const quiet = [
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.com",
            "-c",
            "core.hooksPath=/dev/null",
        ];
        const child = await spawn(["git", ...quiet, "-c", "commit.gpgsign=false", ...args], { cwd: repo });
        if (child.status !== 0) {
            throw new Error(`git ${args.join(" ")}: ${child.stdout}${child.stderr}`);
        }

        // trimEnd, not trim: a porcelain line can start with a space.
        return child.stdout.trimEnd();
    };

    beforeAll(async () => {
        repo = path.join(base, "repo");
        put("repo/Foo.ts", 'export class Foo {\n    readonly name = "foo";\n}\n');
        put("repo/use.ts", USE_TS);
        put(
            "repo/lib/deep.ts",
            'import { Foo } from "../Foo";\n\nexport const kind = (value: Foo): string => value.name;\n'
        );
        await git("init", "-q");
        await git("add", ".");
        await git("commit", "-q", "-m", "fixture");
    });

    test("--find --json answers one ReconReport: the files that name Foo, with counts and the declaring file", async () => {
        const child = await cli(["--find", "Foo", "--roots", ".", "--json", "--cwd", repo], { cwd: base });

        expect(child.status).toBe(0);
        const report: ReconReport = JSON.parse(child.stdout);
        expect(report).toEqual({
            v: 1,
            pattern: "Foo",
            roots: ["."],
            total: 7,
            files: [
                { file: "Foo.ts", count: 1, declares: true },
                { file: "lib/deep.ts", count: 3, declares: false },
                { file: "use.ts", count: 3, declares: false },
            ],
        });
    });

    test("--rename-module - renames the symbol, the file and every …/Foo specifier, staged as a git rename", async () => {
        const params = { file: "Foo.ts", symbol: "Foo", to: "Bar", roots: ["."] };
        let child = await cli(["--rename-module", "-", "--json", "--cwd", repo], {
            cwd: base,
            stdin: JSON.stringify(params),
        });

        expect(child.status).toBe(0);
        const report = reportOf(child);
        expect(report).toMatchObject({ ok: true, written: ["Bar.ts", "lib/deep.ts", "use.ts"] });
        expect(report.files[0]).toMatchObject({ file: "Foo.ts", renamedTo: "Bar.ts", action: "renamed" });
        expect(report.files.every((file) => /^[0-9a-f]{64}$/.test(file.sha256Before ?? ""))).toBe(true);
        expect(report.files.flatMap((file) => file.ops).every((op) => op.expected === op.found)).toBe(true);
        expect((await git("status", "--porcelain")).split("\n")).toEqual([
            "RM Foo.ts -> Bar.ts",
            " M lib/deep.ts",
            " M use.ts",
        ]);
        expect(read("repo/use.ts")).toBe('import { Bar } from "./Bar";\n\nexport const made = new Bar();\n');
        expect(read("repo/lib/deep.ts")).toContain('import { Bar } from "../Bar";');
        expect(read("repo/Bar.ts")).toContain("export class Bar {");
        // Every file carries its full diff on a real run, whose own level is "none" (D6).
        expect(report.files.map((file) => file.diff !== undefined)).toEqual([true, true, true]);
        expect(report.files[2].diff).toContain('+ import { Bar } from "./Bar";');
        backupDir = report.backupDir ?? "";
        expect(backupDir.startsWith(path.join(base, "scratch"))).toBe(true);
        // A run that writes reports the backupDir, and the folder holds the manifest and the originals.
        expect(fs.readdirSync(backupDir)).toEqual(
            expect.arrayContaining(["fable-replace-manifest.json", "0000-Foo.ts"])
        );
        child = await cli(["--rollback", backupDir], { cwd: repo });

        expect(child.status).toBe(0);
        expect(await git("status", "--porcelain")).toBe("");
        expect(read("repo/use.ts")).toBe(USE_TS);
        expect(fs.existsSync(path.join(repo, "Bar.ts"))).toBe(false);
    });

    test("rollback preserves a later staged version of a renamed file", async () => {
        const original = read("repo/Foo.ts");
        const renamed = await cli(["--rename-module", "-", "--json", "--cwd", repo], {
            cwd: base,
            stdin: JSON.stringify({ file: "Foo.ts", symbol: "Foo", to: "Bar", roots: ["."] }),
        });
        expect(renamed.status).toBe(0);
        const backup = reportOf(renamed).backupDir ?? "";
        try {
            put("repo/Bar.ts", "export const laterChange = 2;\n");
            await git("add", "Bar.ts");
            const index = await git("ls-files", "--stage");
            const undone = await cli(["--rollback", backup], { cwd: repo });
            expect(undone.status).toBe(1);
            expect(await git("ls-files", "--stage")).toBe(index);
            expect(read("repo/Bar.ts")).toBe("export const laterChange = 2;\n");
            expect(fs.existsSync(path.join(repo, "Foo.ts"))).toBe(false);
        } finally {
            await git("reset", "-q", "--", "Foo.ts", "Bar.ts");
            fs.renameSync(path.join(repo, "Bar.ts"), path.join(repo, "Foo.ts"));
            put("repo/Foo.ts", original);
            put("repo/use.ts", USE_TS);
            put(
                "repo/lib/deep.ts",
                'import { Foo } from "../Foo";\n\nexport const kind = (value: Foo): string => value.name;\n'
            );
        }
    });

    test("an untracked file with gitMove is renamed as before, and its WARNING is in the report, not on stderr", async () => {
        put("repo/loose.ts", "export const loose = 1;\n");
        const edits = [{ file: "loose.ts", renameTo: "kept.ts", gitMove: true }];
        const child = await cli(["--edits", "-", "--json", "--cwd", repo], { cwd: base, stdin: JSON.stringify(edits) });

        expect(child.status).toBe(0);
        expect(reportOf(child)).toMatchObject({
            ok: true,
            written: ["kept.ts"],
            warnings: ["loose.ts: renamed without git mv (git does not track it)."],
        });
        expect(child.stderr).toBe("");
        expect(await git("status", "--porcelain")).toBe("?? kept.ts");
    });
});
