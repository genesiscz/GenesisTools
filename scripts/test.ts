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

/**
 * Opt-in gates are silent by design: a suite can be green while whole categories
 * (real APIs, e2e, native models, Apple Mail) never ran. Printing the skipped set
 * once per run makes that visible instead of folklore, and names the variable that
 * turns each one on.
 */
/**
 * Mirrors the opt-in gates in src/utils/test/skip.ts.
 *
 * Deliberately duplicated rather than imported: this runner executes BEFORE
 * `bun install` has repaired the dependency tree, and inside a worktree the
 * @genesiscz/utils alias resolves to the main checkout, so importing app code
 * here is exactly the fragility the runner exists to work around.
 * skip.test.ts asserts the two lists stay in step.
 */
const GATE_ENV_VARS: Record<string, string> = {
    network: "RUN_NETWORK_TESTS",
    live: "RUN_LIVE",
    liveSmoke: "RUN_LIVE_SMOKE",
    e2e: "RUN_E2E",
    notifyE2E: "RUN_NOTIFY_E2E",
    wip: "RUN_WIP_E2E",
    darwinkit: "RUN_DARWINKIT",
    solid: "RUN_SOLID",
    mailInfra: "RUN_MAIL_INFRA",
    integration: "RUN_INTEGRATION",
    agentsE2E: "RUN_AGENTS_E2E",
    aiAccounts: "RUN_AI_ACCOUNTS",
    claudeData: "RUN_CLAUDE_DATA",
    localModels: "RUN_LOCAL_MODELS",
    audioDevice: "RUN_AUDIO_DEVICE",
    realApis: "RUN_REAL_APIS",
};

function describeGates(): { enabled: string[]; disabled: string[] } {
    const enabled: string[] = [];
    const disabled: string[] = [];

    for (const [gate, variable] of Object.entries(GATE_ENV_VARS)) {
        const value = process.env[variable];
        const on = value != null && value !== "" && value !== "0" && value.toLowerCase() !== "false";
        (on ? enabled : disabled).push(gate);
    }

    return { enabled: enabled.sort(), disabled: disabled.sort() };
}

function reportGates(): void {
    if (process.env.GENESIS_TOOLS_TEST_QUIET_GATES === "1") {
        return;
    }

    const { enabled, disabled } = describeGates();

    if (enabled.length > 0) {
        process.stderr.write(`\x1b[32m[test] gates ON: ${enabled.join(", ")}\x1b[0m\n`);
    }

    if (disabled.length > 0) {
        const hints = disabled.map((gate) => GATE_ENV_VARS[gate]).join(" ");
        process.stderr.write(
            `\x1b[90m[test] skipped gates (${disabled.length}): ${disabled.join(", ")}\n` +
                `[test] enable with: ${hints
                    .split(" ")
                    .map((v) => `${v}=1`)
                    .join(" ")}\x1b[0m\n`
        );
    }

    process.stderr.write(`\x1b[90m[test] e2e suites are excluded from this run — use \`bun run test:e2e\`\x1b[0m\n`);
}

reportGates();

const proc = Bun.spawn(["bun", "test", ...process.argv.slice(2)], {
    cwd: ROOT,
    stdio: ["inherit", "inherit", "inherit"],
    // Force NODE_ENV=test even when the caller's shell exports something else:
    // two of the keychain safety layers (os-keyring's under-test block and the
    // keychainService() sandboxed item name) key off it, and they must hold in
    // subprocesses tests spawn, which inherit this env.
    env: { ...process.env, NODE_ENV: "test" },
});

process.exit(await proc.exited);
