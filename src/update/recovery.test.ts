import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, recoverFromFailedPull, upstreamRef } from "./recovery";

const dirs: string[] = [];

afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), "update-recovery-"));
    dirs.push(d);

    return d;
}

/** A bare "remote" plus a clone of it, both with one commit. */
async function repoPair(): Promise<{ remote: string; local: string }> {
    const root = await scratch();
    const remote = join(root, "remote.git");
    const work = join(root, "seed");
    const local = join(root, "local");

    await git(["init", "--bare", "-b", "master", remote], root);
    await git(["init", "-b", "master", work], root);
    await git(["config", "user.email", "t@example.com"], work);
    await git(["config", "user.name", "T"], work);
    await writeFile(join(work, "a.txt"), "one\n");
    await git(["add", "."], work);
    await git(["commit", "-m", "one"], work);
    await git(["remote", "add", "origin", remote], work);
    await git(["push", "-u", "origin", "master"], work);
    await git(["clone", remote, local], root);
    await git(["config", "user.email", "t@example.com"], local);
    await git(["config", "user.name", "T"], local);

    return { remote, local };
}

describe("recoverFromFailedPull", () => {
    it("resets onto a rewritten history and keeps local work in a stash", async () => {
        const { remote, local } = await repoPair();

        // the user has uncommitted work: one tracked edit, one untracked file
        await writeFile(join(local, "a.txt"), "edited locally\n");
        await writeFile(join(local, "untracked.txt"), "mine\n");

        // the remote history is REPLACED — no shared commit, which is what a purge does
        const fresh = join(remote, "..", "fresh");
        await git(["init", "-b", "master", fresh], remote);
        await git(["config", "user.email", "t@example.com"], fresh);
        await git(["config", "user.name", "T"], fresh);
        await writeFile(join(fresh, "a.txt"), "rewritten\n");
        await git(["add", "."], fresh);
        await git(["commit", "-m", "rewritten"], fresh);
        await git(["remote", "add", "origin", remote], fresh);
        await git(["push", "--force", "origin", "master"], fresh);

        // a plain pull cannot cross unrelated histories
        const pull = await git(["pull"], local);
        expect(pull.code).not.toBe(0);

        expect(await recoverFromFailedPull(local)).toBe(true);

        // the checkout now matches the rewritten remote
        expect(await Bun.file(join(local, "a.txt")).text()).toBe("rewritten\n");

        // and nothing the user had was destroyed
        const stash = await git(["stash", "list"], local);
        expect(stash.output).toContain("tools update");
        const stashed = await git(["stash", "show", "--include-untracked", "--name-only", "stash@{0}"], local);
        expect(stashed.output).toContain("a.txt");
        expect(stashed.output).toContain("untracked.txt");
    });

    it("does not reset when fetch fails, so a network blip cannot wipe the tree", async () => {
        const { local } = await repoPair();
        await git(["remote", "set-url", "origin", "/nonexistent/definitely-not-a-repo.git"], local);
        await writeFile(join(local, "a.txt"), "precious\n");

        expect(await recoverFromFailedPull(local)).toBe(false);
        expect(await Bun.file(join(local, "a.txt")).text()).toBe("precious\n");
    });

    it("falls back to origin/master when the branch tracks nothing", async () => {
        const { local } = await repoPair();
        await git(["branch", "--unset-upstream"], local);

        expect(await upstreamRef(local)).toBe("origin/master");
    });

    it("recovers from a PARTIAL rewrite, where a shared commit still exists", async () => {
        const { remote, local } = await repoPair();
        const root = join(local, "..");
        const work = join(root, "seed");

        // two more commits on top of the shared root, pushed and pulled
        await writeFile(join(work, "b.txt"), "dirty\n");
        await git(["add", "."], work);
        await git(["commit", "-m", "carries the value"], work);
        await git(["push"], work);
        await git(["pull"], local);

        // rewrite ONLY that last commit; the root keeps its SHA
        await git(["reset", "--hard", "HEAD~1"], work);
        await writeFile(join(work, "b.txt"), "clean\n");
        await git(["add", "."], work);
        await git(["commit", "-m", "redacted"], work);
        await git(["push", "--force"], work);

        // a merge-base still exists — the old signal would have called this "ordinary"
        const shared = await git(["merge-base", "HEAD", "origin/master"], local);
        expect(shared.code).toBe(0);

        await git(["fetch", "origin"], local);
        const failed = await git(["-c", "pull.rebase=false", "pull"], local);
        expect(failed.code).not.toBe(0);

        expect(await recoverFromFailedPull(local)).toBe(true);
        expect(await Bun.file(join(local, "b.txt")).text()).toBe("clean\n");
        expect(remote).toBeTruthy();
    });

    it("parks local commits on a branch before resetting, rather than losing them", async () => {
        const { local } = await repoPair();
        const root = join(local, "..");
        const work = join(root, "seed");

        await writeFile(join(local, "mine.txt"), "my work\n");
        await git(["add", "."], local);
        await git(["commit", "-m", "my local commit"], local);

        await writeFile(join(work, "a.txt"), "rewritten\n");
        await git(["add", "."], work);
        await git(["commit", "--amend", "-m", "rewritten root"], work);
        await git(["push", "--force"], work);

        expect(await recoverFromFailedPull(local)).toBe(true);

        const branches = await git(["branch", "--list", "tools-update-backup-*"], local);
        expect(branches.output).toContain("tools-update-backup-");
        const kept = await git(["log", "--format=%s", "-1", branches.output.trim().replace("* ", "")], local);
        expect(kept.output).toContain("my local commit");
    });

    it("handles the ordinary case too: a dirty tree blocking a fast-forward", async () => {
        const { local } = await repoPair();
        const work = join(local, "..", "seed");

        // upstream moves forward normally — no rewrite at all
        await writeFile(join(work, "a.txt"), "upstream change\n");
        await git(["add", "."], work);
        await git(["commit", "-m", "upstream moves on"], work);
        await git(["push"], work);

        // the user has an uncommitted edit to the same file, so the pull refuses
        await writeFile(join(local, "a.txt"), "my uncommitted edit\n");
        const pull = await git(["pull"], local);
        expect(pull.code).not.toBe(0);

        expect(await recoverFromFailedPull(local)).toBe(true);

        // the checkout is on the upstream commit...
        expect(await Bun.file(join(local, "a.txt")).text()).toBe("upstream change\n");

        // ...and the edit is recoverable, not gone
        const stash = await git(["stash", "list"], local);
        expect(stash.output).toContain("tools update");
        const shown = await git(["stash", "show", "-p", "stash@{0}"], local);
        expect(shown.output).toContain("my uncommitted edit");
    });
});
