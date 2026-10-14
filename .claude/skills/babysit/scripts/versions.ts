/**
 * Merge-prep git for restack.ts and pick-unified.ts: the only conflicts a script may resolve are the plugin version
 * files, and they resolve to the HIGHER version (a stacked child can fork before its parent's later bumps, so "the
 * replayed side" can be a downgrade). Every other conflict belongs to a worker or the lead.
 */

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

/** Hooks off (HOOKS_OFF; a post-checkout hook froze for minutes on a stuck syspolicyd) and rerere off (a remembered resolution
 * staged itself, hiding the conflict and an old version number). */
export function prepGit(cwd: string): GitRun {
    return (args) => {
        const p = Bun.spawnSync(["git", ...HOOKS_OFF, "-c", "rerere.enabled=false", ...args], {
            cwd,
            stdout: "pipe",
            stderr: "pipe",
            env: { ...process.env, GIT_EDITOR: "true" },
        });
        return { code: p.exitCode ?? 1, out: `${p.stdout.toString()}${p.stderr.toString()}` };
    };
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

/** Stages the higher version of each conflicted version file. False, touching nothing, when another file conflicts. */
export function resolveVersionConflicts(git: GitRun, conflicted: string[]): boolean {
    if (conflicted.length === 0 || conflicted.some((file) => !VERSION_FILES.has(file))) {
        return false;
    }

    for (const file of conflicted) {
        // Stage 2 is "ours" (the branch being built), stage 3 "theirs" (the commit being replayed or picked).
        git([
            "checkout",
            higherVersionSide(git(["show", `:2:${file}`]).out, git(["show", `:3:${file}`]).out),
            "--",
            file,
        ]);
        git(["add", "--", file]);
    }

    return true;
}
