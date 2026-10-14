#!/usr/bin/env bun
/**
 * Rebase a PR worktree onto a new base for merge prep, with hooks and rerere off. Conflicts in the plugin version
 * files resolve to the higher version; any other conflict aborts the rebase and is reported, because resolving real
 * code belongs to a worker or the lead, not to a script (versions.ts).
 *
 *   bun restack.ts --wt <worktree> --onto <ref> [--upstream <old base commit>]
 *
 * `--upstream` drops the commits a squash-merged parent already brought in (`git rebase --onto <ref> <upstream>`).
 * Nothing is pushed: check the result, run the area tests, then push with --force-with-lease.
 */
import { flag } from "./run";
import { conflictedFiles, prepGit, resolveVersionConflicts } from "./versions";

const wt = flag("--wt") ?? "";
const onto = flag("--onto") ?? "";
const upstream = flag("--upstream");

if (!wt || !onto) {
    console.error("usage: restack.ts --wt <worktree> --onto <ref> [--upstream <old base commit>]");
    process.exit(2);
}

const git = prepGit(wt);

if (git(["status", "--porcelain", "--untracked-files=no"]).out.trim()) {
    console.error("✖ the worktree has uncommitted changes");
    process.exit(1);
}

let step = git(["rebase", "-q", ...(upstream ? ["--onto", onto, upstream] : [onto])]);
let resolved = 0;

while (step.code !== 0) {
    const conflicted = conflictedFiles(git);

    if (!resolveVersionConflicts(git, conflicted)) {
        git(["rebase", "--abort"]);
        console.log(
            `✖ conflict outside the version files, rebase aborted: ${conflicted.join(" ") || step.out.slice(0, 300)}`
        );
        process.exit(1);
    }

    resolved += conflicted.length;
    step = git(["rebase", "--continue"]);
}

const head = git(["rev-parse", "--short", "HEAD"]).out.trim();
const count = git(["rev-list", "--count", `${onto}..HEAD`]).out.trim();
console.log(`✔ rebased onto ${onto}: ${count} commits, head ${head}, ${resolved} version-file conflict(s) resolved`);
