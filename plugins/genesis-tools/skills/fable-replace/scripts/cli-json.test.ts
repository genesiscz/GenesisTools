import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ReconReport, RunReportJson } from "./types";

// The CLI's JSON doors through the real CLI: --edits - with --json answers one JSON object on stdout (the human lines
// go to stderr), a MISS is ok false with its reason, --quiet alone gives the stat level, --find answers a ReconReport,
// and --rename-module - renames a symbol, its file and every import in a git fixture as one staged git rename, which
// --rollback undoes. The gitMove cases live here and not in runner-output.test.ts, so git runs in the CLI child and
// never through spawnSync in this test worker (oven-sh/bun#34069). Six bun spawns and one git fixture repo; every
// child is awaited.

const CLI = path.join(import.meta.dir, "cli.ts");
const SESSION_KEYS = ["CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "FABLE_REPLACE_SESSION", "FABLE_REPLACE_HARNESS"];
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
        expect(child.stderr).toContain("edits: 2 file(s), 2 op(s) — DRY RUN");
        expect(read("edits/a.ts")).toBe("const x = 1;\n");
    });

    test("an absent needle is ok false with exit 1 and its reason; --quiet alone gives each file a stat and no diff", async () => {
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
        expect(child.stderr).toContain("b.ts (edited) +1 -1");
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
        const child = await cli(["--rename-module", "-", "--json", "--cwd", repo], {
            cwd: base,
            stdin: JSON.stringify(params),
        });

        expect(child.status).toBe(0);
        const report = reportOf(child);
        expect(report).toMatchObject({ ok: true, written: ["Foo.ts → Bar.ts", "lib/deep.ts", "use.ts"] });
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
    });

    test("--rollback of that run unstages the git rename and restores every file", async () => {
        const child = await cli(["--rollback", backupDir], { cwd: repo });

        expect(child.status).toBe(0);
        expect(await git("status", "--porcelain")).toBe("");
        expect(read("repo/use.ts")).toBe(USE_TS);
        expect(fs.existsSync(path.join(repo, "Bar.ts"))).toBe(false);
    });

    test("an untracked file with gitMove is renamed as before, with one WARNING line on stderr", async () => {
        put("repo/loose.ts", "export const loose = 1;\n");
        const edits = [{ file: "loose.ts", renameTo: "kept.ts", gitMove: true }];
        const child = await cli(["--edits", "-", "--json", "--cwd", repo], { cwd: base, stdin: JSON.stringify(edits) });

        expect(child.status).toBe(0);
        expect(reportOf(child)).toMatchObject({ ok: true, written: ["loose.ts → kept.ts"] });
        expect(child.stderr.split("\n").filter((line) => line.startsWith("WARNING"))).toEqual([
            "WARNING: loose.ts: renamed without git mv (git does not track it).",
        ]);
        expect(await git("status", "--porcelain")).toBe("?? kept.ts");
    });
});
