#!/usr/bin/env bun
/**
 * Rebase a PR worktree onto a new base for merge prep, with hooks and rerere off. Leave conflicts in place for
 * resolve-same.ts or a manual resolution.
 *
 *   bun restack.ts --wt <worktree> --onto <ref> [--upstream <old base commit>]
 *
 * `--upstream` drops the commits a squash-merged parent already brought in (`git rebase --onto <ref> <upstream>`).
 * Nothing is pushed: check the result, run the area tests, then push with --force-with-lease.
 */
import { flag } from "./run";
import { conflictedFiles, prepGit } from "./versions";

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

const step = git([
    "rebase",
    "-q",
    "--empty=stop",
    "--reapply-cherry-picks",
    ...(upstream ? ["--onto", onto, upstream] : [onto]),
]);
if (step.code !== 0) {
    const conflicted = conflictedFiles(git);
    console.log(`✖ rebase stopped: ${conflicted.join(" ") || step.out.slice(0, 300)}`);
    process.exit(1);
}

const head = git(["rev-parse", "--short", "HEAD"]).out.trim();
const count = git(["rev-list", "--count", `${onto}..HEAD`]).out.trim();
console.log(`✔ rebased onto ${onto}: ${count} commits, head ${head}`);
