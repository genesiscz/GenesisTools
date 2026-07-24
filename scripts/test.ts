#!/usr/bin/env bun
import { dirname, join } from "node:path";
import { diagnose, lockStamp, STAMP_FILE } from "./test-deps";

/**
 * `bun test` wrapper that refuses to run against a broken dependency tree.
 *
 * The failure this prevents: inside a git worktree, any `bunx` call creates a
 * PARTIAL `node_modules/` that shadows the parent checkout's complete one. Every
 * subsequent `bun test` then dies with resolution errors like
 * `Cannot find module 'parse5/lib/common/doctype'` across a hundred unrelated
 * files, which reads exactly like the branch broke the world. It cost a real
 * debugging detour before anyone thought to look at `node_modules`.
 *
 * The guard is a handful of `stat` calls (~1ms), so it can sit in front of every
 * run. argv, output and exit code pass straight through — this must be invisible
 * when the tree is healthy.
 */

const ROOT = dirname(import.meta.dir);
const STAMP = join(ROOT, "node_modules", STAMP_FILE);

function warn(message: string): void {
    process.stderr.write(`\x1b[33m[test] ${message}\x1b[0m\n`);
}

async function stampMatches(): Promise<boolean> {
    const file = Bun.file(STAMP);

    if (!(await file.exists())) {
        return false;
    }

    return (await file.text()).trim() === lockStamp(ROOT);
}

async function install(reason: string): Promise<void> {
    warn(`${reason} — running bun install`);

    const proc = Bun.spawn(["bun", "install"], { cwd: ROOT, stdio: ["inherit", "inherit", "inherit"] });
    const code = await proc.exited;

    if (code === 0) {
        await Bun.write(STAMP, lockStamp(ROOT));
        return;
    }

    // A non-zero exit is usually a POSTINSTALL failing (puppeteer downloading a
    // browser, a native build), which says nothing about whether the packages
    // the tests import actually landed. Re-check the tree instead of assuming:
    // blocking a green suite over an unrelated postinstall would make this guard
    // worse than the problem it prevents.
    const stillBroken = diagnose(ROOT);

    if (stillBroken) {
        process.stderr.write(`\x1b[31m[test] bun install failed (exit ${code}) and ${stillBroken}\x1b[0m\n`);
        process.exit(code);
    }

    warn(`bun install exited ${code} (likely a postinstall), but the tree resolves — continuing`);
    // No stamp after a partial install: re-verify next run rather than recording
    // a state we are not sure about.
}

const broken = diagnose(ROOT);

if (broken) {
    await install(broken);
} else if (!(await stampMatches())) {
    // Lockfile moved since the last verified install (branch switch, pull).
    await install("dependencies are stale");
}

const proc = Bun.spawn(["bun", "test", ...process.argv.slice(2)], {
    cwd: ROOT,
    stdio: ["inherit", "inherit", "inherit"],
});

process.exit(await proc.exited);
