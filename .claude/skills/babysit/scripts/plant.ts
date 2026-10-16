#!/usr/bin/env bun
/**
 * The planted-regression check for a fix round: put the pre-fix version of the fixed sources back, run the tests (they
 * must FAIL), restore the fixed files, run them again (they must PASS), and prove the worktree is as it was.
 *
 *   bun plant.ts --wt <worktree> --file <path> [--file <path>…] [--from HEAD~1] --test "<test paths>"
 *   bun plant.ts --wt <worktree> --file <path> --swift-package <dir> --swift-filter <Class[/test]>
 *
 * Exit 0 only when the planted run failed and the fixed run passed. Hand-written plant loops went wrong twice on
 * 2026-10-14: an unsplit zsh variable ran no test at all, and a `shift` in a shell function sent every backup to a
 * bad path while the old version was still written, which left the pre-fix code in two worktrees.
 */
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function flags(name: string): string[] {
    const found: string[] = [];

    for (let i = 2; i < process.argv.length; i++) {
        if (process.argv[i] === name && process.argv[i + 1] !== undefined) {
            found.push(process.argv[i + 1]);
        }
    }

    return found;
}

function exec(cmd: string[], cwd: string): { code: number; out: string } {
    const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: process.env });
    return { code: p.exitCode ?? 1, out: `${p.stdout.toString()}${p.stderr.toString()}` };
}

/** The pass and fail counts a test run printed (bun or XCTest). */
export function summarize(out: string): string {
    const bun = [...out.matchAll(/^\s*(\d+) (pass|fail)$/gm)].map((m) => `${m[1]} ${m[2]}`);

    if (bun.length > 0) {
        return bun.join(" ");
    }

    return out.match(/Executed \d+ tests?, with \d+ failures?[^\n]*/g)?.at(-1) ?? "no test count";
}

export function testEvidence(result: { code: number; out: string }, failing: boolean): boolean {
    const { code, out } = result;
    if (failing ? code === 0 : code !== 0) {
        return false;
    }
    if (
        /error:.*(?:Cannot find|Could not resolve|No matching export|SyntaxError)|Build failed|compilation failed/i.test(
            out
        )
    ) {
        return false;
    }
    if (out.includes("[test] suite complete")) {
        const pass = [...out.matchAll(/^\s*(\d+) pass$/gm)].reduce((n, m) => n + Number(m[1]), 0);
        const fail = [...out.matchAll(/^\s*(\d+) fail$/gm)].reduce((n, m) => n + Number(m[1]), 0);
        return (
            out.includes(`[test] suite complete (exit ${code})`) &&
            (failing ? fail > 0 && /^\(fail\)/m.test(out) : pass > 0 && fail === 0)
        );
    }
    const total = [...out.matchAll(/Executed (\d+) tests?, with (\d+) failures?/g)].at(-1);
    return !!total && Number(total[1]) > 0 && (failing ? Number(total[2]) > 0 : Number(total[2]) === 0);
}

if (import.meta.main) {
    const wt = flags("--wt")[0];
    const files = flags("--file");
    const from = flags("--from")[0] ?? "HEAD~1";
    const tests = (flags("--test")[0] ?? "").split(/\s+/).filter(Boolean);
    const swiftPackage = flags("--swift-package")[0];
    const swiftFilter = flags("--swift-filter")[0];

    if (!wt || files.length === 0 || (tests.length === 0 && !(swiftPackage && swiftFilter))) {
        console.error(
            'usage: plant.ts --wt <dir> --file <path>… [--from HEAD~1] (--test "<paths>" | --swift-package <dir> --swift-filter <f>)'
        );
        process.exit(2);
    }

    const runTests = (): { code: number; out: string } =>
        swiftPackage && swiftFilter
            ? exec(["swift", "test", "--filter", swiftFilter], join(wt, swiftPackage))
            : exec(["bun", "scripts/test.ts", ...tests], wt);

    const before = exec(["git", "status", "--short", "--untracked-files=no"], wt).out;
    const backup = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "babysit-plant-"));
    const old = new Map<string, string>();

    // Read every old version and back up every fixed file BEFORE writing anything: a miss stops with nothing changed.
    for (const [i, file] of files.entries()) {
        const shown = exec(["git", "show", `${from}:${file}`], wt);

        if (shown.code !== 0) {
            console.error(`✖ git show ${from}:${file} failed, nothing planted: ${shown.out.trim().slice(0, 200)}`);
            process.exit(1);
        }

        old.set(file, shown.out);
        mkdirSync(join(backup, String(i)), { recursive: true });
        copyFileSync(join(wt, file), join(backup, String(i), "fixed"));
    }

    let planted: { code: number; out: string };

    try {
        for (const [file, text] of old) {
            writeFileSync(join(wt, file), text);
        }

        planted = runTests();
    } finally {
        for (const [i, file] of files.entries()) {
            copyFileSync(join(backup, String(i), "fixed"), join(wt, file));
        }
    }

    const after = exec(["git", "status", "--short", "--untracked-files=no"], wt).out;

    if (after !== before) {
        console.error(`✖ the worktree differs after the restore; the fixed copies are in ${backup}\n${after}`);
        process.exit(1);
    }

    const fixed = runTests();
    await Bun.write(join(backup, "planted.log"), planted.out);
    await Bun.write(join(backup, "fixed.log"), fixed.out);
    console.log(`planted (${from}): exit ${planted.code} · ${summarize(planted.out)}`);

    for (const line of planted.out
        .split("\n")
        .filter((l) => /^\(fail\)|error: -\[/.test(l))
        .slice(0, 6)) {
        console.log(`  ${line.slice(0, 160)}`);
    }

    console.log(`fixed: exit ${fixed.code} · ${summarize(fixed.out)}`);
    console.log(`worktree restored as it was · logs in ${backup}`);

    if (!testEvidence(planted, true)) {
        console.log("✖ the planted run has no completed failing-test evidence");
        process.exit(1);
    }

    if (!testEvidence(fixed, false)) {
        console.log("✖ the fixed run has no completed passing-test evidence");
        process.exit(1);
    }

    console.log("✔ the tests catch the fault and pass on the fix");
}
