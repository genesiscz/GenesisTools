/**
 * Merge-prep git for restack.ts and pick-unified.ts: the only conflicts a script may resolve are the plugin version
 * files, and they resolve to the HIGHER version (a stacked child can fork before its parent's later bumps, so "the
 * replayed side" can be a downgrade). Every other conflict belongs to a worker or the lead.
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { resolutionProblems } from "./conflicts";
import { type DeadlineSpawn, spawnWithDeadline } from "./run";

export const VERSION_FILES = new Set([
    ".claude-plugin/marketplace.json",
    "plugins/genesis-tools/.claude-plugin/plugin.json",
]);

export type GitRun = (args: string[]) => { code: number; out: string };

const HOOK_EVENTS = [
    "pre-commit",
    "commit-msg",
    "post-commit",
    "post-checkout",
    "pre-push",
    "post-merge",
    "post-rewrite",
];

/**
 * Git options that turn every hook off. `core.hooksPath=/dev/null` alone stops only the hooks directory: hooks set in
 * config (`[hook "<name>"] command/event`, git 2.48+) ignore it, and 84dcc30a1 moved this repo's hooks there
 * (measured 2026-10-14 on git 2.55: only `hook.<event>.enabled=false` or `hook.<name>.enabled=false` stopped one).
 */
export const HOOKS_OFF = [
    "-c",
    "core.hooksPath=/dev/null",
    ...HOOK_EVENTS.flatMap((event) => [
        "-c",
        `hook.${event}.enabled=false`,
        "-c",
        `hook.genesis-tools-${event}.enabled=false`,
    ]),
];

/**
 * The hooks run the gates (Biome, tsgo, the commit subject rules, the personal-data probe), so turning them off for a
 * commit or a push is allowed only while this returns true: a brand-new two-line script does not start within the
 * timeout. That is the signature of a stuck syspolicyd, which froze the first exec of every new file from 04:57 to
 * 06:05 on 2026-10-14 (hook copies, a worktree's biome, fresh test bundles). Once it recovers, the hooks run again.
 */
export async function newExecutablesStall(timeoutMs = 5_000): Promise<boolean> {
    const dir = mkdtempSync(join(tmpdir(), "babysit-exec-probe-"));
    const file = join(dir, "probe");
    writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const proc = Bun.spawn([file], { stdout: "ignore", stderr: "ignore" });
    const started = await Promise.race([proc.exited.then(() => true), Bun.sleep(timeoutMs).then(() => false)]);

    if (!started) {
        // A process frozen in exec still takes a signal; never wait for it.
        proc.kill();
    }

    // syspolicyd may still be checking this executable after the child exits or is signalled. Keep it.
    return !started;
}

/**
 * The repo's hooks run as config hooks through their interpreter only while `core.hooksPath` is unset
 * (`scripts/git/install-hooks.ts`). An install or a checkout on a branch with the older `prepare` sets it back to
 * `.githooks`, git then executes each worktree's new hook copy directly, and a stuck syspolicyd froze every such
 * first run (2026-10-14: commits from three sessions hung at their pre-commit hook). Before a commit or a push this
 * puts the config hooks back with the repo's own installer, which Martin allowed the babysit to run.
 */
export function ensureConfigHooks(main: string): string {
    const listed = Bun.spawnSync(["git", "hook", "list", "pre-commit"], {
        cwd: main,
        stdout: "pipe",
        stderr: "pipe",
        env: env.getProcessEnv(),
    });

    if (!listed.stdout.toString().includes("hook from hookdir")) {
        return "config hooks in place";
    }

    const installer = join(main, "scripts/git/install-hooks.ts");

    if (!existsSync(installer)) {
        return "⚠ git runs the hook folder, and this checkout has no installer";
    }

    const fixed = Bun.spawnSync(["bun", installer], {
        cwd: main,
        stdout: "pipe",
        stderr: "pipe",
        env: env.getProcessEnv(),
    });
    return fixed.exitCode === 0
        ? "⚠ core.hooksPath was set again: the installer put the config hooks back"
        : `⚠ the hook installer failed: ${fixed.stderr.toString().trim().slice(0, 200)}`;
}

/** Hooks off for the mechanical replays (rebase, cherry-pick, worktree add), which run no gate hook anyway: only
 * post-checkout and post-rewrite fire there, and a post-checkout hook froze for minutes on a stuck syspolicyd. Rerere
 * off too (a remembered resolution
 * staged itself, hiding the conflict and an old version number). */
export function prepGit(cwd: string): GitRun {
    return (args) => {
        const p = spawnGit([...HOOKS_OFF, "-c", "rerere.enabled=false", ...args], {
            cwd,
            env: { ...env.getProcessEnv(), GIT_EDITOR: "true" },
        });
        return { code: p.exitCode ?? 1, out: `${p.stdout.toString()}${p.stderr.toString()}` };
    };
}

/** The longest one git call of a restack may run. Hooks are off, but commit signing can still wait on its program
 * forever, and one stuck child would hold resolve-same.ts past its round limit. */
export const GIT_DEADLINE_MS = 300_000;

type GitSpawn = Omit<DeadlineSpawn, "timeoutMs"> & { timeoutMs?: number };

/** `git <args>` with a deadline. On expiry it throws, so the script stops with that reason instead of reading the
 * killed run as an ordinary exit code (a timed-out `rev-parse --verify` would read as "no such ref"). */
export function spawnGit(args: string[], options: GitSpawn = {}) {
    const timeoutMs = options.timeoutMs ?? GIT_DEADLINE_MS;
    const result = spawnWithDeadline(["git", ...args], { ...options, timeoutMs });
    if (result.exitedDueToTimeout) {
        const shown = args.filter((arg, i) => arg !== "-c" && args[i - 1] !== "-c").join(" ");
        throw new Error(`git ${shown} did not finish within ${timeoutMs / 1000} s and was stopped`);
    }

    return result;
}

/** `spawnGit` for a call that must exit with one of `okCodes` (0 when unset). Any other exit throws
 * `git <cmd>: <stderr>`. */
export function mustGit(args: string[], options: GitSpawn & { okCodes?: number[] } = {}) {
    const { okCodes = [0], ...spawn } = options;
    const result = spawnGit(args, spawn);
    if (!okCodes.includes(result.exitCode ?? -1)) {
        throw new Error(`git ${args[0]}: ${result.stderr.toString().trim()}`);
    }

    return result;
}

/**
 * `git cherry <upstream> <head> [<limit>]` with verbatim patch ids: the commits of `upstream..head` (after `limit`)
 * whose change `upstream` does not hold byte for byte. `git cherry` strips every space, so a commit that changes only
 * the spaces inside a string literal reads as already upstream.
 */
export function unpickedCommits(options: { cwd: string; upstream: string; head: string; limit?: string }): string[] {
    const { cwd, upstream, head, limit } = options;
    const must = (args: string[], stdin?: Uint8Array) => mustGit(args, { cwd, stdin }).stdout.toString();
    const patchIds = (range: string[]) => {
        const log = must([
            "log",
            "-p",
            "--no-merges",
            "--no-color",
            "--no-ext-diff",
            "--binary",
            "--format=commit %H",
            ...range,
        ]);
        const ids = new Map<string, string>();
        for (const line of must(["patch-id", "--verbatim"], Buffer.from(log)).split("\n")) {
            const [id, commit] = line.split(" ");
            if (id && commit) {
                ids.set(commit, id);
            }
        }

        return ids;
    };
    const own = [`${upstream}..${head}`, ...(limit ? [`^${limit}`] : [])];
    const ownIds = patchIds(own);
    // An upstream commit holds an own commit's change only when it changes the same files, so only the upstream commits
    // that touch a file of `own` are hashed: `head..upstream` is every commit master gained since the fork. The paths
    // go on stdin, which has no argument limit; --full-history keeps a commit that history simplification would hide.
    const ownFiles = [
        ...new Set(
            must(["log", "--no-merges", "--format=", "--name-only", "-z", ...own])
                .split("\0")
                .filter(Boolean)
        ),
    ];
    const touching = ownFiles.length
        ? must(
              ["log", "--no-merges", "--full-history", "--format=%H", "--stdin"],
              Buffer.from(`${head}..${upstream}\n--\n${ownFiles.map((file) => `:(literal)${file}\n`).join("")}`)
          )
              .split("\n")
              .filter(Boolean)
        : [];
    const upstreamIds = new Set(touching.length ? patchIds(["--no-walk", ...touching]).values() : []);
    return must(["rev-list", "--no-merges", "--reverse", ...own])
        .split("\n")
        .filter(Boolean)
        .filter((commit) => !upstreamIds.has(ownIds.get(commit) ?? ""));
}

export function conflictedFiles(git: GitRun): string[] {
    return git(["diff", "--name-only", "--diff-filter=U"]).out.split("\n").filter(Boolean);
}

function versionOf(json: string): number[] {
    return (/"version":\s*"(\d+)\.(\d+)\.(\d+)"/.exec(json)?.slice(1) ?? ["0", "0", "0"]).map(Number);
}

export function higherVersionSide(ours: string, theirs: string): "--ours" | "--theirs" {
    const [a, b] = [versionOf(ours), versionOf(theirs)];
    const i = a.findIndex((n, index) => n !== b[index]);
    return i >= 0 && (a[i] ?? 0) > (b[i] ?? 0) ? "--ours" : "--theirs";
}

/** Resolve only version lines in the already-merged working text. Validate every file before writing any. */
export function resolveVersionConflicts(git: GitRun, conflicted: string[]): boolean {
    if (conflicted.length === 0 || conflicted.some((file) => !VERSION_FILES.has(file))) {
        return false;
    }

    const top = git(["rev-parse", "--show-toplevel"]);

    if (top.code !== 0) {
        return false;
    }

    const root = top.out.trim();
    const resolved = new Map<string, string>();

    for (const file of conflicted) {
        const text = resolveVersionText(readFileSync(join(root, file), "utf8"));

        if (text === null) {
            return false;
        }

        resolved.set(file, text);
    }

    const problems = resolutionProblems(conflicted, (file) => resolved.get(file) ?? "");

    if (problems.length > 0) {
        for (const problem of problems) {
            console.error(`✖ ${problem}`);
        }

        return false;
    }

    for (const [file, text] of resolved) {
        writeFileSync(join(root, file), text);

        if (git(["add", "--", file]).code !== 0) {
            return false;
        }
    }

    return true;
}

export function resolveVersionText(text: string): string | null {
    let count = 0;
    let valid = true;
    const versionLine = /^([ \t]*"version"[ \t]*:[ \t]*")(\d+\.\d+\.\d+)(",?[ \t]*\r?\n?)$/;
    const resolved = text.replace(
        /^<<<<<<<[^\n]*\n([\s\S]*?)^=======[ \t]*\r?\n([\s\S]*?)^>>>>>>>[^\n]*(?:\n|$)/gm,
        (_block, left: string, right: string) => {
            count++;
            const [ours, base] = left.split(/^\|{7}[^\n]*\n/m);
            const a = versionLine.exec(ours);
            const b = versionLine.exec(right);
            if (!a || !b || a[1] !== b[1] || a[3] !== b[3] || (base !== undefined && !versionLine.test(base))) {
                valid = false;
                return _block;
            }
            return higherVersionSide(ours, right) === "--ours" ? ours : right;
        }
    );
    return valid && count > 0 && !/^(?:<{7}|={7}|>{7}|\|{7})(?:\s|$)/m.test(resolved) ? resolved : null;
}
