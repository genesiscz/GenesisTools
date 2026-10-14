#!/usr/bin/env bun
/**
 * Rebase a PR worktree onto a new base for merge prep, with git hooks off (a post-checkout hook froze for minutes
 * while syspolicyd was stuck, 2026-10-14). Conflicts in the plugin version files resolve to whichever side has the
 * HIGHER version (a stacked child can fork before its parent's later bumps, so "the replayed side" can be a
 * downgrade); any other conflict aborts the rebase and is reported, because resolving real code belongs to a worker
 * or the lead, not to a script.
 *
 *   bun restack.ts --wt <worktree> --onto <ref> [--upstream <old base commit>]
 *
 * `--upstream` drops the commits a squash-merged parent already brought in (`git rebase --onto <ref> <upstream>`).
 * Nothing is pushed: check the result, run the area tests, then push with --force-with-lease.
 */
import { flag } from "./run";

const VERSION_FILES = new Set([".claude-plugin/marketplace.json", "plugins/genesis-tools/.claude-plugin/plugin.json"]);
const wt = flag("--wt") ?? "";
const onto = flag("--onto") ?? "";
const upstream = flag("--upstream");

function git(args: string[]): { code: number; out: string } {
    // rerere would replay a remembered resolution and stage it, hiding the conflict (and an old version number).
    const p = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", "-c", "rerere.enabled=false", ...args], {
        cwd: wt,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, GIT_EDITOR: "true" },
    });
    return { code: p.exitCode ?? 1, out: `${p.stdout.toString()}${p.stderr.toString()}` };
}

if (!wt || !onto) {
    console.error("usage: restack.ts --wt <worktree> --onto <ref> [--upstream <old base commit>]");
    process.exit(2);
}

if (git(["status", "--porcelain", "--untracked-files=no"]).out.trim()) {
    console.error("✖ the worktree has uncommitted changes");
    process.exit(1);
}

function versionOf(json: string): number[] {
    return (/"version":\s*"(\d+)\.(\d+)\.(\d+)"/.exec(json)?.slice(1) ?? ["0", "0", "0"]).map(Number);
}

function higherVersionSide(ours: string, theirs: string): "--ours" | "--theirs" {
    const [a, b] = [versionOf(ours), versionOf(theirs)];
    const i = a.findIndex((n, index) => n !== b[index]);
    return i >= 0 && (a[i] ?? 0) > (b[i] ?? 0) ? "--ours" : "--theirs";
}

let step = git(["rebase", "-q", ...(upstream ? ["--onto", onto, upstream] : [onto])]);
let resolved = 0;

while (step.code !== 0) {
    const conflicted = git(["diff", "--name-only", "--diff-filter=U"]).out.split("\n").filter(Boolean);

    if (conflicted.length === 0 || conflicted.some((file) => !VERSION_FILES.has(file))) {
        git(["rebase", "--abort"]);
        console.log(
            `✖ conflict outside the version files, rebase aborted: ${conflicted.join(" ") || step.out.slice(0, 300)}`
        );
        process.exit(1);
    }

    for (const file of conflicted) {
        // Stage 2 is the rebased side so far ("ours"), stage 3 the commit being replayed ("theirs").
        const side = higherVersionSide(git(["show", `:2:${file}`]).out, git(["show", `:3:${file}`]).out);
        git(["checkout", side, "--", file]);
        git(["add", "--", file]);
        resolved++;
    }

    step = git(["rebase", "--continue"]);
}

const head = git(["rev-parse", "--short", "HEAD"]).out.trim();
const count = git(["rev-list", "--count", `${onto}..HEAD`]).out.trim();
console.log(`✔ rebased onto ${onto}: ${count} commits, head ${head}, ${resolved} version-file conflict(s) resolved`);
