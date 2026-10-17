#!/usr/bin/env bun
/**
 * Carry judged round commits onto the integration branch, in order, in the checkout that has it. A commit already
 * there (same patch) is skipped; a conflict in only the plugin version files resolves to the higher version; any other
 * conflict aborts that one pick and is listed, for a worker in a scratch worktree of the branch (versions.ts).
 *
 *   bun pick-unified.ts --branch <integration branch> [--repo <checkout>] <sha> [<sha> ...]
 *
 * Refuses to start unless <checkout> is on <branch> with a clean tree. Exit 1 when any pick conflicted.
 */
import { flag } from "./run";
import { conflictedFiles, type GitRun, prepGit, resolveVersionConflicts } from "./versions";

export function continueVersionPick(git: GitRun): { code: number; out: string; skipped?: boolean } {
    const continued = git(["cherry-pick", "--continue"]);
    if (continued.code === 0) {
        return continued;
    }

    // Only a live single-pick state with no conflicts and an empty index can be skipped.
    const state = git(["rev-parse", "--verify", "CHERRY_PICK_HEAD"]);
    const unmerged = git(["ls-files", "-u"]);
    const index = git(["diff", "--cached", "--quiet", "HEAD", "--"]);
    if (state.code !== 0 || unmerged.code !== 0 || unmerged.out.trim() || index.code !== 0) {
        return continued;
    }

    const skipped = git(["cherry-pick", "--skip"]);
    return skipped.code === 0
        ? { ...skipped, skipped: true }
        : { code: skipped.code, out: continued.out + skipped.out };
}

function main(): void {
    const branch = flag("--branch") ?? "";
    const repo = flag("--repo") ?? process.cwd();
    const shas = process.argv.slice(2).filter((arg, i, all) => !arg.startsWith("--") && !all[i - 1]?.startsWith("--"));

    if (!branch || shas.length === 0) {
        console.error("usage: pick-unified.ts --branch <integration branch> [--repo <checkout>] <sha> [<sha> ...]");
        process.exit(2);
    }

    const git = prepGit(repo);

    if (git(["rev-parse", "--abbrev-ref", "HEAD"]).out.trim() !== branch) {
        console.error(`✖ ${repo} is not on ${branch}`);
        process.exit(1);
    }

    let conflicts = 0;

    for (const sha of shas) {
        if (git(["status", "--porcelain", "--untracked-files=no"]).out.trim()) {
            console.error("✖ the working tree is not clean; stopping");
            process.exit(1);
        }

        const subject = git(["log", "-1", "--format=%s", sha]).out.trim().slice(0, 90);

        if (
            git(["cherry", "HEAD", sha, `${sha}~1`])
                .out.trim()
                .startsWith("-")
        ) {
            console.log(`= ${sha} already on ${branch}: ${subject}`);
            continue;
        }

        if (git(["cherry-pick", "-x", sha]).code === 0) {
            console.log(`✔ ${sha} → ${git(["rev-parse", "--short", "HEAD"]).out.trim()}: ${subject}`);
            continue;
        }

        const conflicted = conflictedFiles(git);

        if (resolveVersionConflicts(git, conflicted)) {
            const result = continueVersionPick(git);
            if (result.code !== 0) {
                console.error("\u2716 " + sha + " continuation failed; pick preserved: " + result.out.trim());
                process.exit(1);
            }

            console.log(
                result.skipped
                    ? "= " + sha + " empty after the version resolution, skipped: " + subject
                    : "\u2714 " +
                          sha +
                          " \u2192 " +
                          git(["rev-parse", "--short", "HEAD"]).out.trim() +
                          " (version files): " +
                          subject
            );
            continue;
        }

        git(["cherry-pick", "--abort"]);
        conflicts++;
        console.log(`✖ ${sha} CONFLICT [${conflicted.join(", ")}]: ${subject}`);
    }

    process.exit(conflicts > 0 ? 1 : 0);
}

if (import.meta.main) {
    main();
}
