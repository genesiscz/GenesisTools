#!/usr/bin/env bun
/**
 * Registers every hook in `.githooks/` with git as a config hook (`hook.genesis-tools-<name>`). Runs from
 * package.json `prepare`.
 *
 * Git executes a `core.hooksPath` hook file directly, and macOS checks the first execution of every new file in
 * syspolicyd. A worktree's hook files are new copies. On 2026-10-14 a syspolicyd instance stopped answering those
 * checks: every first execution froze at `_dyld_start`, and a `git worktree add` and a rebase hung on their hook
 * for 41 minutes. A config hook runs through `/bin/sh -c`, so git starts only the shell and the hook's interpreter,
 * which have run before, and the hook file is only read.
 *
 *   bun scripts/git/install-hooks.ts           configure this repository (all its worktrees share the config)
 *   bun scripts/git/install-hooks.ts --print   print the git commands instead of running them
 *
 * A git that does not list the configured hooks (one without config hooks) keeps `core.hooksPath = .githooks`.
 *
 * A config hook runs only while `core.hooksPath` is unset, so a set one still decides: `-c core.hooksPath=/dev/null`
 * turns every hook off, and a branch whose older `prepare` sets `.githooks` again runs each hook once, not twice.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const HOOKS_DIR = ".githooks";
const PREFIX = "genesis-tools-";
const root = join(import.meta.dir, "..", "..");
const print = process.argv.includes("--print");

function read(args: string[]): string | null {
    const proc = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    return proc.exitCode === 0 ? proc.stdout.toString().trim() : null;
}

function change(args: string[]): void {
    if (print) {
        console.log(`git ${args.map((arg) => (/^[\w./=-]+$/.test(arg) ? arg : `'${arg}'`)).join(" ")}`);
        return;
    }

    const proc = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "ignore", stderr: "pipe" });
    if (proc.exitCode !== 0) {
        throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString().trim()}`);
    }
}

// An install from a tarball has no repository to configure.
if (read(["rev-parse", "--git-dir"]) === null) {
    process.exit(0);
}

const hooks = readdirSync(join(root, HOOKS_DIR)).flatMap((name) => {
    const firstLine = readFileSync(join(root, HOOKS_DIR, name), "utf8").split("\n", 1)[0] ?? "";
    return firstLine.startsWith("#!") ? [{ name, interpreter: firstLine.slice(2).trim() }] : [];
});

for (const { name, interpreter } of hooks) {
    // A branch from before a hook existed has no file for it: the commit or checkout goes on.
    const path = `${HOOKS_DIR}/${name}`;
    const command = `git config --get core.hooksPath >/dev/null || test ! -f ${path} || exec ${interpreter} ${path}`;
    change(["config", `hook.${PREFIX}${name}.command`, command]);
    change(["config", "--replace-all", `hook.${PREFIX}${name}.event`, name]);
}

const localHooksPath = read(["config", "--local", "--get", "core.hooksPath"]);
const inheritedHooksPath =
    read(["config", "--global", "--get", "core.hooksPath"]) ?? read(["config", "--system", "--get", "core.hooksPath"]);
const managesHooksPath = (localHooksPath === null || localHooksPath === HOOKS_DIR) && inheritedHooksPath === null;
const probe = hooks[0]?.name;
const listed = probe !== undefined && (read(["hook", "list", probe]) ?? "").includes(`${PREFIX}${probe}`);

if (managesHooksPath) {
    if (print) {
        console.log("git config --unset core.hooksPath   # only when `git hook list` names the configured hooks");
    } else if (!listed) {
        // This git ignores config hooks, so the repository-owned hook folder must stay the way hooks run.
        change(["config", "--local", "core.hooksPath", HOOKS_DIR]);
    } else if (localHooksPath === HOOKS_DIR) {
        // Unsetting this would expose an inherited path, so only migrate when no global or system path exists.
        change(["config", "--local", "--unset", "core.hooksPath"]);
    }
}
