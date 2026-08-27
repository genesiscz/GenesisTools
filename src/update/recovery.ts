import { out } from "@genesiscz/utils/logger";
import pc from "picocolors";

/** Run a git command, capturing both streams so a failure can be explained rather than guessed at. */
export async function git(args: string[], cwd: string): Promise<{ code: number; output: string }> {
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);

    return { code, output: `${stdout}${stderr}`.trim() };
}

/** The branch this checkout tracks, or origin/master when it tracks nothing. */
export async function upstreamRef(cwd: string): Promise<string> {
    const res = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], cwd);

    return res.code === 0 && res.output ? res.output : "origin/master";
}

/**
 * Recover from a `git pull` that failed, without losing anything the user has locally.
 *
 * The case this exists for: a rewritten or force-pushed upstream. Measured on a lab repo
 * where only the last two commits were rewritten (the earlier ones kept their SHAs), a
 * collaborator who had already pulled got:
 *
 *   merge (the default)  exit 1    conflicts, and the old commits still in the ancestry
 *   rebase               exit 0    clean
 *   ff-only              exit 128  refuses
 *
 * There is deliberately ONE path: stash, then reset onto the tracked upstream. An earlier
 * version tried to classify the failure and retry the pull when it looked ordinary, which was
 * wrong twice — first because a merge-base exists in a partial rewrite too, then because a
 * conflicted merge blocks the stash. And it was pointless: when HEAD is already an ancestor
 * of the upstream a successful pull is a fast-forward, and the reset lands on exactly that
 * same commit. The reset is also independent of the user's pull.rebase and pull.ff settings,
 * which this tool does not control.
 *
 * What must NOT be simplified away:
 *   - the fetch guard, or a network blip would reset onto a stale ref and silently move the
 *     checkout backwards;
 *   - the stash, which covers uncommitted work, tracked and untracked;
 *   - the backup branch, because a stash does NOT cover committed work and the reset would
 *     take it.
 *
 * `git stash push --include-untracked` takes tracked modifications AND untracked files
 * without staging anything, so no `git add` is needed beforehand.
 *
 * Returns false when the caller should stop and print manual guidance instead.
 */
export async function recoverFromFailedPull(cwd: string): Promise<boolean> {
    // A failed pull can leave a conflicted merge or a half-finished rebase in place, and git
    // refuses to stash in either state. Clear it before anything else; both aborts are no-ops
    // when nothing is in progress.
    await git(["merge", "--abort"], cwd);
    await git(["rebase", "--abort"], cwd);

    const fetched = await git(["fetch", "origin"], cwd);

    if (fetched.code !== 0) {
        out.error(pc.red("  git fetch also failed — this looks like a network or auth problem, not history."));
        out.println(pc.dim(`  ${fetched.output.split("\n").slice(-3).join("\n  ")}`));

        return false;
    }

    const upstream = await upstreamRef(cwd);
    // Diverged when HEAD is not contained in the upstream. Covers a full rewrite (no shared
    // commit at all) AND a partial one (early commits keep their SHAs, so a merge-base still
    // exists but a plain pull conflicts).
    const contained = await git(["merge-base", "--is-ancestor", "HEAD", upstream], cwd);
    const diverged = contained.code !== 0;

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const stash = await git(["stash", "push", "--include-untracked", "-m", `tools update ${stamp}`], cwd);
    const stashed = stash.code === 0 && !stash.output.includes("No local changes");

    if (stash.code !== 0) {
        out.error(pc.red("  Could not stash local changes; refusing to touch the working tree."));
        out.println(pc.dim(`  ${stash.output}`));

        return false;
    }

    // Committed work is not covered by a stash, so park it on a branch before resetting.
    const ahead = await git(["rev-list", "--count", `${upstream}..HEAD`], cwd);
    const localCommits = Number(ahead.output) || 0;

    if (localCommits > 0) {
        const backup = `tools-update-backup-${stamp}`;
        const saved = await git(["branch", backup, "HEAD"], cwd);

        if (saved.code !== 0) {
            out.error(pc.red(`  Could not save ${localCommits} local commit(s); refusing to reset.`));
            out.println(pc.dim(`  ${saved.output}`));

            return false;
        }

        out.println(pc.yellow(`  ${localCommits} local commit(s) saved on branch ${backup}.`));
        out.println(pc.dim(`    git rebase --onto ${upstream} ${upstream}@{1} ${backup}   # replay them`));
    }

    if (diverged) {
        out.println(pc.yellow(`  This checkout has diverged from ${upstream} — it was rewritten or force-pushed.`));
    }

    const reset = await git(["reset", "--hard", upstream], cwd);

    if (reset.code !== 0) {
        out.error(pc.red(`  git reset --hard ${upstream} failed.`));
        out.println(pc.dim(`  ${reset.output}`));

        return false;
    }

    out.println(pc.dim(`  Reset to ${upstream}.`));

    if (stashed) {
        out.println(pc.yellow("  Your local changes are in a stash — they were NOT applied:"));
        out.println(pc.dim("    git stash list          # find it"));
        out.println(pc.dim("    git stash pop           # if the history was not rewritten"));
        out.println(pc.dim(`    git stash branch rescue # if it was: replays your work onto ${upstream}`));
    }

    return true;
}
