import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAsCaller } from "@genesiscz/utils/agent/runtime";
import { env } from "@genesiscz/utils/env";
import { isJsonObject, SafeJSON } from "@genesiscz/utils/json";
import { answerText } from "@genesiscz/utils/mcp/tool-entry";
import type { RunReportJson } from "../../../../plugins/genesis-tools/skills/fable-replace/scripts/types";
import {
    FABLE_REPLACE_CLI_PATH,
    handleGenesisReplace,
    handleGenesisReplaceFind,
    type ReplaceChildRequest,
    type ReplaceChildResult,
    spawnCli,
} from "./genesis-replace";

/** Absolute and existing; the fake spawner never runs anything in it. */
const CWD = tmpdir();
const EDITS = [{ file: "a.ts", ops: [{ find: "oldName", replace: "newName" }] }];

function fakeSpawner(result: Partial<ReplaceChildResult> = {}) {
    const calls: ReplaceChildRequest[] = [];
    const spawn = async (request: ReplaceChildRequest): Promise<ReplaceChildResult> => {
        calls.push(request);
        return { exitCode: 0, stdout: "", stderr: "", ...result };
    };

    return { calls, spawn };
}

function runReport(overrides: Record<string, unknown> = {}): RunReportJson {
    return {
        v: 1,
        ok: true,
        exitCode: 0,
        dryRun: true,
        missCount: 0,
        written: [],
        files: [
            {
                file: "a.ts",
                action: "edited",
                diffStat: { added: 1, removed: 1 },
                ops: [{ status: "OK", desc: "oldName", expected: 1, found: 1, lines: [1] }],
                postConditionFailures: [],
            },
        ],
        ...overrides,
    };
}

function answerOf(answer: Awaited<ReturnType<typeof handleGenesisReplace>>) {
    if (typeof answer === "string") {
        throw new Error(`expected an answer object, got the text "${answer}"`);
    }

    return answer;
}

/** A failure's one text block, parsed: what a code-mode REPL hands its caller as e.detail when the call throws. */
function detailOf(answer: Awaited<ReturnType<typeof handleGenesisReplace>>): Record<string, unknown> {
    const object = answerOf(answer);
    expect(object.isError).toBe(true);
    const detail: unknown = SafeJSON.parse(object.text, { strict: true });
    if (!isJsonObject(detail)) {
        throw new Error(`the failure text is not one JSON object: ${object.text}`);
    }

    expect(object.structuredContent).toEqual(detail);
    return detail;
}

describe("genesis_replace with a fake spawner", () => {
    test("a dry edits call sends the edits on stdin and answers the child's report as structuredContent", async () => {
        const report = runReport();
        const { calls, spawn } = fakeSpawner({ stdout: SafeJSON.stringify(report), stderr: "spec: 1 file(s)\n" });
        const answer = answerOf(await handleGenesisReplace({ cwd: CWD, edits: EDITS, dryRun: true }, { spawn }));

        expect(calls).toHaveLength(1);
        const [call] = calls;
        expect(call.argv[0]).toBe(process.execPath);
        expect(call.argv[1]).toBe(FABLE_REPLACE_CLI_PATH);
        expect(existsSync(call.argv[1])).toBe(true);
        expect(call.argv.slice(2)).toEqual(["--edits", "-", "--json", "--cwd", CWD, "--dry", "--diff", "stat"]);
        expect(SafeJSON.parse(call.stdin ?? "", { strict: true })).toEqual(EDITS);
        expect(call.cwd).toBe(CWD);
        expect(call.timeoutMs).toBe(16 * 60_000);
        expect(call.env.NO_COLOR).toBe("1");

        expect(answer.structuredContent).toEqual(report);
        expect(answer.isError).toBe(false);
        expect(SafeJSON.parse(answer.text, { strict: true })).toEqual(report);
    });

    test("a failed run answers isError with ONE text block: the report as JSON, its summary keeping the stderr tail", async () => {
        const report = runReport({ ok: false, exitCode: 1, dryRun: false, missCount: 1 });
        const stderr = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n");
        const { spawn } = fakeSpawner({ exitCode: 1, stdout: SafeJSON.stringify(report), stderr });
        const detail = detailOf(await handleGenesisReplace({ cwd: CWD, edits: EDITS }, { spawn }));
        const lines = String(detail.summary).split("\n");

        expect(detail).toMatchObject(report);
        expect(lines[0]).toBe("genesis_replace: FAILED, exit 1, 1 file(s), 0 written, 1 MISS");
        expect(lines.slice(2)).toHaveLength(60);
        expect(lines[2]).toBe("… 41 earlier stderr line(s) cut");
        expect(lines.at(-1)).toBe("line 100");
        expect(String(detail.summary)).not.toContain("line 41\n");
    });

    test("a MISS names its reason in the summary, and exit 3 keeps written, backupDir and the rollback command", async () => {
        const missed = runReport({
            ok: false,
            exitCode: 1,
            dryRun: false,
            missCount: 1,
            files: [
                {
                    file: "a.ts",
                    action: "unchanged",
                    ops: [{ status: "MISS", desc: 'replace "oldName"', reason: "needle not found." }],
                    postConditionFailures: [],
                },
            ],
        });
        const missSpawner = fakeSpawner({ exitCode: 1, stdout: SafeJSON.stringify(missed) });
        const miss = detailOf(await handleGenesisReplace({ cwd: CWD, edits: EDITS }, { spawn: missSpawner.spawn }));
        expect(String(miss.summary)).toContain('MISS a.ts: replace "oldName": needle not found.');

        const red = runReport({
            ok: false,
            exitCode: 3,
            dryRun: false,
            written: ["Bar.ts", "a.ts"],
            files: [
                { file: "Foo.ts", renamedTo: "Bar.ts", action: "renamed", ops: [], postConditionFailures: [] },
                { file: "a.ts", action: "edited", ops: [], postConditionFailures: [] },
            ],
            backupDir: "/tmp/fixture-backup",
            verify: { command: "false", status: "fail", exitCode: 1, timedOut: false, control: "caught", shown: [] },
        });
        const redSpawner = fakeSpawner({ exitCode: 3, stdout: SafeJSON.stringify(red) });
        const written = detailOf(await handleGenesisReplace({ cwd: CWD, edits: EDITS }, { spawn: redSpawner.spawn }));
        expect(written).toMatchObject({ exitCode: 3, written: ["Bar.ts", "a.ts"], backupDir: "/tmp/fixture-backup" });
        // written is plain paths; the summary a person reads shows the rename as its pair.
        expect(String(written.summary)).toContain("keep the sweep: Foo.ts → Bar.ts, a.ts.");
        expect(String(written.summary)).toContain("verify fail (control caught)");
        expect(String(written.summary)).toContain("'--rollback' '/tmp/fixture-backup'");
    });

    test("spawn failure and a file cwd produce parseable failures", async () => {
        const fixture = mkdtempSync(join(tmpdir(), "replace-launch-"));
        const file = join(fixture, "file");
        writeFileSync(file, "fixture");
        try {
            const invalid = detailOf(await handleGenesisReplace({ cwd: file, edits: EDITS }));
            expect(invalid.exitCode).toBe(2);
        } finally {
            rmSync(fixture, { recursive: true, force: true });
        }
        const failed = detailOf(
            await handleGenesisReplace(
                { cwd: CWD, edits: EDITS },
                {
                    spawn: async () => {
                        throw new Error("fixture launch failure");
                    },
                }
            )
        );
        expect(failed.ok).toBe(false);
        expect(String(failed.summary)).toContain("outcome is unknown");
    });

    test("a stray stdout line before the report does not hide it", async () => {
        const report = runReport();
        const { spawn } = fakeSpawner({ stdout: `a stray line\n${SafeJSON.stringify(report)}\n` });
        const answer = answerOf(await handleGenesisReplace({ cwd: CWD, edits: EDITS, dryRun: true }, { spawn }));

        expect(answer.isError).toBe(false);
        expect(answer.structuredContent).toEqual(report);
    });

    test("a child without one JSON report is a failure report with its exit code and the ends of its output", async () => {
        const crashed = fakeSpawner({ exitCode: 2, stdout: "spec: 1 file(s)\n", stderr: "TypeError: boom\n" });
        const crash = detailOf(await handleGenesisReplace({ cwd: CWD, edits: EDITS }, { spawn: crashed.spawn }));

        expect(crash).toMatchObject({
            v: 1,
            ok: false,
            exitCode: 2,
            error: "the fable-replace CLI exited 2 without a JSON report on stdout",
        });
        expect(String(crash.summary)).toContain(
            "genesis_replace: the fable-replace CLI exited 2 without a JSON report on stdout."
        );
        expect(String(crash.summary)).toContain("spec: 1 file(s)");
        expect(String(crash.summary)).toContain("TypeError: boom");

        const otherShape = fakeSpawner({ stdout: '{"v":2,"ok":true}' });
        detailOf(await handleGenesisReplace({ cwd: CWD, edits: EDITS }, { spawn: otherShape.spawn }));

        const stopped = fakeSpawner({ exitCode: null, stoppedBy: "deadline" });
        const late = detailOf(await handleGenesisReplace({ cwd: CWD, edits: EDITS }, { spawn: stopped.spawn }));
        expect(late).toMatchObject({ exitCode: null, stoppedBy: "deadline" });
        expect(String(late.summary)).toContain("was stopped after 16 minutes");
    });

    test("a bad call is refused before any spawn, as an exit 2 report", async () => {
        const { calls, spawn } = fakeSpawner({ stdout: SafeJSON.stringify(runReport()) });
        const refusals: Array<[Record<string, unknown>, string]> = [
            [{ cwd: "repo", edits: EDITS }, "cwd must be an absolute path"],
            [{ edits: EDITS }, "cwd is required"],
            [{ cwd: join(CWD, "no-such-folder-for-genesis-replace"), edits: EDITS }, "does not exist"],
            [{ cwd: CWD }, "pass exactly one of edits, spec or renameModule"],
            [{ cwd: CWD, edits: EDITS, spec: "@@ a.ts" }, "(got edits and spec)"],
            [{ cwd: CWD, edits: [] }, "edits must be a non-empty array"],
            [{ cwd: CWD, edits: EDITS, dry: true }, 'unknown argument "dry"'],
            [{ cwd: CWD, edits: EDITS, diff: "huge" }, "diff must be one of none, stat, full"],
            [{ cwd: CWD, edits: EDITS, verifyControl: "swift" }, "verifyControl must be one of ts"],
            [{ cwd: CWD, renameModule: "Foo" }, "renameModule must be an object"],
        ];

        for (const [args, message] of refusals) {
            const detail = detailOf(await handleGenesisReplace(args, { spawn }));
            expect(detail).toMatchObject({ v: 1, ok: false, exitCode: 2 });
            expect(String(detail.error)).toContain(message);
            expect(detail.summary).toBe(detail.error);
        }

        expect(calls).toHaveLength(0);
    });

    test("the calling session and its harness reach the child's environment; the sessionId input wins", async () => {
        const { calls, spawn } = fakeSpawner({ stdout: SafeJSON.stringify(runReport()) });
        const caller = { agent: "claude-code" as const, sessionId: "session-alpha", cwd: null };

        await runAsCaller(caller, () => handleGenesisReplace({ cwd: CWD, edits: EDITS }, { spawn }));
        await runAsCaller(caller, () =>
            handleGenesisReplace({ cwd: CWD, edits: EDITS, sessionId: "session-beta" }, { spawn })
        );

        expect(calls.map((call) => call.env.FABLE_REPLACE_SESSION)).toEqual(["session-alpha", "session-beta"]);
        expect(calls.map((call) => call.env.FABLE_REPLACE_HARNESS)).toEqual(["claude", "claude"]);
    });

    test("in a caller scope the process's own harness session variables never reach the child", async () => {
        const { calls, spawn } = fakeSpawner({ stdout: SafeJSON.stringify(runReport()) });
        const unnamed = { agent: "unknown" as const, sessionId: null, cwd: null };
        env.testing.set("CLAUDE_CODE_SESSION_ID", "session-of-the-gateway");
        env.testing.set("FABLE_REPLACE_SESSION", "inherited-fable-session");
        env.testing.set("FABLE_REPLACE_HARNESS", "codex");
        try {
            await runAsCaller(unnamed, () => handleGenesisReplace({ cwd: CWD, edits: EDITS }, { spawn }));
            await handleGenesisReplace({ cwd: CWD, edits: EDITS }, { spawn });
        } finally {
            env.testing.unset("CLAUDE_CODE_SESSION_ID");
            env.testing.unset("FABLE_REPLACE_SESSION");
            env.testing.unset("FABLE_REPLACE_HARNESS");
        }

        expect(calls[0].env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
        expect(calls[0].env.FABLE_REPLACE_SESSION).toBeUndefined();
        expect(calls[0].env.FABLE_REPLACE_HARNESS).toBeUndefined();
        // A stdio server has no caller scope: its environment is its host session's own.
        expect(calls[1].env.CLAUDE_CODE_SESSION_ID).toBe("session-of-the-gateway");
    });

    test("the spec and renameModule doors, the verify flags and the diff level reach the CLI", async () => {
        const { calls, spawn } = fakeSpawner({ stdout: SafeJSON.stringify(runReport()) });
        const spec = "@@ a.ts\n<<<\noldName\n===\nnewName\n>>>\n";
        const rename = { file: "src/Widget.ts", symbol: "Widget", to: "Gadget", roots: ["src"] };

        await handleGenesisReplace({ cwd: CWD, spec, diff: "full" }, { spawn });
        await handleGenesisReplace(
            { cwd: CWD, renameModule: rename, verify: "tsc-rs --noEmit -p tsconfig.json", verifyControl: "ts" },
            { spawn }
        );

        expect(calls[0].argv.slice(2)).toEqual(["--json", "--cwd", CWD, "--diff", "full"]);
        expect(calls[0].stdin).toBe(spec);
        expect(calls[1].argv.slice(2)).toEqual([
            "--rename-module",
            "-",
            "--json",
            "--cwd",
            CWD,
            "--diff",
            "stat",
            "--verify",
            "tsc-rs --noEmit -p tsconfig.json",
            "--verify-control",
            "ts",
        ]);
        expect(SafeJSON.parse(calls[1].stdin ?? "", { strict: true })).toEqual(rename);
    });
});

describe("genesis_replace_find with a fake spawner", () => {
    const recon = {
        v: 1,
        pattern: "Widget",
        roots: ["."],
        total: 3,
        files: [
            { file: "src/Widget.ts", count: 2, declares: true },
            { file: "src/use.ts", count: 1, declares: false },
        ],
    };

    test("a literal find answers the ReconReport", async () => {
        const { calls, spawn } = fakeSpawner({ stdout: SafeJSON.stringify(recon) });
        const answer = answerOf(await handleGenesisReplaceFind({ cwd: CWD, pattern: "Widget" }, { spawn }));

        expect(calls[0].argv.slice(2)).toEqual(["--find-json", "-", "--cwd", CWD, "--json"]);
        expect(SafeJSON.parse(calls[0].stdin ?? "", { strict: true })).toMatchObject({
            pattern: "Widget",
            roots: ["."],
        });
        expect(answer.structuredContent).toEqual(recon);
        expect(answer.isError).toBeUndefined();
        expect(SafeJSON.parse(answerText(answer), { strict: true })).toEqual(recon);
    });

    test("typed find input preserves regexes and slash-leading literals", async () => {
        const { calls, spawn } = fakeSpawner({ stdout: SafeJSON.stringify(recon) });

        await handleGenesisReplaceFind(
            {
                cwd: CWD,
                pattern: 'from "./utils/(\\w+)"',
                regex: true,
                flags: "i",
                roots: ["src", "lib"],
                exts: [".ts"],
            },
            { spawn }
        );
        await handleGenesisReplaceFind({ cwd: CWD, pattern: "/utils/(old)" }, { spawn });

        expect(SafeJSON.parse(calls[0].stdin ?? "", { strict: true })).toEqual({
            pattern: 'from "./utils/(\\w+)"',
            regex: true,
            flags: "i",
            roots: ["src", "lib"],
            exts: [".ts"],
        });
        expect(SafeJSON.parse(calls[1].stdin ?? "", { strict: true })).toMatchObject({
            pattern: "/utils/(old)",
            regex: false,
        });
    });

    test("flags without regex, a missing pattern and a non-string root are refused before any spawn", async () => {
        const { calls, spawn } = fakeSpawner({ stdout: SafeJSON.stringify(recon) });
        const refusals: Array<[Record<string, unknown>, string]> = [
            [{ cwd: CWD, pattern: "x", flags: "i" }, "flags needs regex: true"],
            [{ cwd: CWD }, "pattern is required"],
            [{ cwd: CWD, pattern: "x", roots: [5] }, "non-empty string"],
        ];

        for (const [args, message] of refusals) {
            const detail = detailOf(await handleGenesisReplaceFind(args, { spawn }));
            expect(detail).toMatchObject({ v: 1, ok: false, exitCode: 2 });
            expect(String(detail.error)).toContain(message);
        }

        expect(calls).toHaveLength(0);
    });

    test("a failure report of the CLI answers isError, and its text is that report", async () => {
        const failed = {
            v: 1,
            ok: false,
            exitCode: 1,
            dryRun: false,
            missCount: 0,
            written: [],
            files: [],
            error: "boom",
        };
        const { spawn } = fakeSpawner({ exitCode: 1, stdout: SafeJSON.stringify(failed) });
        const detail = detailOf(await handleGenesisReplaceFind({ cwd: CWD, pattern: "x" }, { spawn }));

        expect(detail).toMatchObject(failed);
        expect(detail.summary).toBe("genesis_replace_find: FAILED, exit 1, error: boom");
    });
});

describe("the default spawner", () => {
    test("a cancelled CLI leaves no owned control probe in the worktree", async () => {
        const fixture = mkdtempSync(join(tmpdir(), "replace-control-cancel-"));
        writeFileSync(join(fixture, "a.ts"), "export const oldName = 1;\n");
        try {
            const ended = await spawnCli({
                cwd: fixture,
                env: { ...env.getProcessEnv(), FABLE_REPLACE_SCRATCH_ROOT: join(fixture, "backup") },
                argv: [
                    process.execPath,
                    FABLE_REPLACE_CLI_PATH,
                    "--edits",
                    "-",
                    "--json",
                    "--verify",
                    "sleep 30",
                    "--verify-control",
                    "ts",
                ],
                stdin: SafeJSON.stringify(EDITS),
                timeoutMs: 1500,
            });
            expect(ended.stoppedBy).toBe("deadline");
            expect(readFileSync(join(fixture, "a.ts"), "utf8")).toContain("newName");
            expect(readdirSync(fixture).some((file) => file.startsWith("fable-replace-probe"))).toBe(false);
        } finally {
            rmSync(fixture, { recursive: true, force: true });
        }
    });

    test("a deadline ends the verifier descendant as well as its shell", async () => {
        const stopped = await spawnCli({
            cwd: CWD,
            env: env.getProcessEnv(),
            timeoutMs: 100,
            argv: ["sh", "-c", "sleep 30 & echo $!; wait"],
        });
        expect(stopped.stoppedBy).toBe("deadline");
        const pid = Number(stopped.stdout.trim());
        expect(pid).toBeGreaterThan(1);
        const probe = Bun.spawn(["ps", "-p", String(pid), "-o", "stat="], {
            env: env.getProcessEnv(),
            stdout: "pipe",
            stderr: "pipe",
        });
        const state = (await new Response(probe.stdout).text()).trim();
        await probe.exited;
        expect(state === "" || state.startsWith("Z")).toBe(true);
    });

    test("a pathological regex is interrupted by the independent child deadline", async () => {
        const result = await spawnCli({
            cwd: CWD,
            env: env.getProcessEnv(),
            timeoutMs: 100,
            argv: [process.execPath, "-e", '/^(a+)+$/.test("a".repeat(100000) + "!");'],
        });
        expect(result.stoppedBy).toBe("deadline");
        expect(result.exitCode).not.toBe(0);
    });

    test("an oversized child report ends with a bounded output-limit failure", async () => {
        const result = await spawnCli({
            cwd: CWD,
            env: env.getProcessEnv(),
            timeoutMs: 5000,
            argv: [process.execPath, "-e", 'process.stdout.write("x".repeat(9 * 1024 * 1024));'],
        });
        expect(result.stoppedBy).toBe("output-limit");
        expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(8 * 1024 * 1024);
    });

    test("feeds stdin, and ends the child on a cancel or at its deadline", async () => {
        const base = { cwd: CWD, env: env.getProcessEnv(), timeoutMs: 60_000 };
        const cancel = new AbortController();
        setTimeout(() => cancel.abort(), 50);
        const started = Date.now();
        const [echoed, cancelled, late] = await Promise.all([
            spawnCli({ ...base, argv: ["cat"], stdin: "hello from stdin" }),
            spawnCli({ ...base, argv: ["sleep", "30"], signal: cancel.signal }),
            spawnCli({ ...base, argv: ["sleep", "30"], timeoutMs: 50 }),
        ]);

        expect(echoed).toEqual({ exitCode: 0, stdout: "hello from stdin", stderr: "" });
        expect(cancelled.stoppedBy).toBe("cancelled");
        expect(late.stoppedBy).toBe("deadline");
        expect(Date.now() - started).toBeLessThan(10_000);
    });
});

/** The CLI's JSON door lands with package P3; until then this case has nothing to call. */

describe("genesis_replace with the real CLI", () => {
    test("one call writes a fixture, genesis_replace_find counts it, and a MISS and a red verify answer their report", async () => {
        const base = mkdtempSync(join(tmpdir(), "genesis-replace-"));
        const repo = join(base, "repo");
        mkdirSync(repo);
        env.testing.set("FABLE_REPLACE_SCRATCH_ROOT", join(base, "scratch"));
        try {
            for (const name of ["a.ts", "b.ts", "c.ts"]) {
                writeFileSync(join(repo, name), `export const oldName = "${name}";\n`);
            }

            const edits = ["a.ts", "b.ts", "c.ts"].map((file) => ({
                file,
                ops: [{ find: "oldName", replace: "newName" }],
            }));
            const written = answerOf(await handleGenesisReplace({ cwd: repo, edits }));
            expect(written.isError).toBe(false);
            expect(written.structuredContent).toMatchObject({ v: 1, ok: true, exitCode: 0 });
            expect(readFileSync(join(repo, "b.ts"), "utf8")).toBe('export const newName = "b.ts";\n');

            const found = answerOf(await handleGenesisReplaceFind({ cwd: repo, pattern: "newName" }));
            expect(found.structuredContent).toMatchObject({ v: 1, total: 3 });

            // "e" occurs three times in "export const newName", so a one-letter replacement found by chance is no earlier run.
            const missEdits = [{ file: "a.ts", ops: [{ find: "nope-not-there", replace: "e" }] }];
            const miss = detailOf(await handleGenesisReplace({ cwd: repo, edits: missEdits }));
            expect(miss).toMatchObject({ ok: false, exitCode: 1, written: [], files: [{ file: "a.ts" }] });
            expect("backupDir" in miss).toBe(false);
            expect(String(miss.summary)).toContain("needle not found");
            expect(String(miss.summary)).not.toContain("REPLACEMENT");

            const redEdits = [{ file: "c.ts", ops: [{ find: "newName", replace: "laterName" }] }];
            const red = detailOf(await handleGenesisReplace({ cwd: repo, edits: redEdits, verify: "false" }));
            expect(red).toMatchObject({ ok: false, exitCode: 3, written: ["c.ts"], verify: { status: "fail" } });
            expect(existsSync(join(String(red.backupDir), "fable-replace-manifest.json"))).toBe(true);
            expect(String(red.summary)).toContain(`'--rollback' '${String(red.backupDir)}'`);
        } finally {
            env.testing.unset("FABLE_REPLACE_SCRATCH_ROOT");
            rmSync(base, { recursive: true, force: true });
        }
    });
});
