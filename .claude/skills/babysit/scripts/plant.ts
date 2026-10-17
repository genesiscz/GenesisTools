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
import { stripVTControlCharacters } from "node:util";
import { env } from "@genesiscz/utils/env";

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
    const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: env.getProcessEnv() });
    return { code: p.exitCode ?? 1, out: `${p.stdout.toString()}${p.stderr.toString()}` };
}

function counts(out: string) {
    const text = stripVTControlCharacters(out);
    const bun = [...text.matchAll(/^\s*(\d+) (pass|fail)\s*$/gm)];
    const swift = [...text.matchAll(/Executed (\d+) tests?, with (?:\d+ tests? skipped and )?(\d+) failures?[^\n]*/g)];
    return {
        text,
        bun,
        swift,
        pass: bun.reduce((total, match) => total + (match[2] === "pass" ? Number(match[1]) : 0), 0),
        fail: bun.reduce((total, match) => total + (match[2] === "fail" ? Number(match[1]) : 0), 0),
    };
}

/** The pass and fail counts a test run printed (bun or the final XCTest total). */
export function summarize(out: string): string {
    const parsed = counts(out);
    if (parsed.bun.length > 0) {
        return parsed.bun.map((match) => match[1] + " " + match[2]).join(" ");
    }

    return parsed.swift.at(-1)?.[0] ?? "no test count";
}

function loadFailure(result: { code: number; out: string }): boolean {
    const parsed = counts(result.out);
    return (
        result.code !== 0 &&
        parsed.pass === 0 &&
        !parsed.swift.some((match) => Number(match[1]) > 0) &&
        /Unhandled error between tests|SyntaxError|error:.*(?:Cannot find|Could not resolve|No matching export)/i.test(
            parsed.text
        )
    );
}

export function testEvidence(result: { code: number; out: string }, failing: boolean): boolean {
    const { code, out } = result;
    const parsed = counts(out);
    if (failing) {
        return (
            code !== 0 &&
            !loadFailure(result) &&
            (parsed.fail > 0 || parsed.swift.some((match) => Number(match[1]) > 0 && Number(match[2]) > 0))
        );
    }

    // A test may log an expected compiler/import error. Completed counts decide; no counts cannot pass.
    if (code !== 0) {
        return false;
    }

    if (parsed.bun.length > 0) {
        return parsed.pass > 0 && parsed.fail === 0 && parsed.text.includes("[test] suite complete (exit 0)");
    }

    return parsed.swift.some((match) => Number(match[1]) > 0) && parsed.swift.every((match) => Number(match[2]) === 0);
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
            ? exec(
                  [
                      "bun",
                      join(import.meta.dir, "swift-slot.ts"),
                      "--wait-minutes",
                      "40",
                      "--run-minutes",
                      "60",
                      "--",
                      "swift",
                      "test",
                      "--filter",
                      swiftFilter,
                  ],
                  join(wt, swiftPackage)
              )
            : exec(["bun", "scripts/test.ts", ...tests], wt);

    const before = exec(["git", "status", "--short", "--untracked-files=no"], wt).out;
    const backup = mkdtempSync(join(env.get("TMPDIR") ?? "/tmp", "babysit-plant-"));
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

    if (loadFailure(planted)) {
        console.log("✖ the plant broke the test's import, plant a behaviour fault instead");
        process.exit(1);
    }

    if (!testEvidence(planted, true)) {
        console.log("✖ the planted run has no failing-test evidence");
        process.exit(1);
    }

    if (!testEvidence(fixed, false)) {
        console.log("✖ the fixed run has no completed passing-test evidence");
        process.exit(1);
    }

    console.log("✔ the tests catch the fault and pass on the fix");
}
