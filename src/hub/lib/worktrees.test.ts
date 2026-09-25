import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestRepo } from "@genesiscz/utils/git/test-repo";
import { Command, CommanderError } from "commander";
import {
    type BlockerKind,
    cleanupBlockers,
    type LiveUsers,
    ownerOf,
    parseStashList,
    removeWorktrees,
    scanWorktrees,
    stashBranch,
    stashesFor,
    unresolvedBase,
    type WorktreeCleanupRow,
    type WorktreeFacts,
    worktreeSizes,
} from "./worktrees";
import { registerWorktreesCommand } from "./worktrees-command";

function facts(overrides: Partial<WorktreeFacts> = {}): WorktreeFacts {
    return {
        path: "/work/app.worktrees/feat-x",
        repoRoot: "/work/app",
        repo: "app",
        branch: "feat/x",
        head: "a".repeat(40),
        present: true,
        locked: null,
        prunable: null,
        verdict: "MERGED",
        how: "content",
        verdictError: null,
        statusError: null,
        base: "origin/master",
        changedCount: 0,
        changed: [],
        untrackedCount: 0,
        untracked: [],
        ignored: [],
        stashes: [],
        processes: [],
        sessions: [],
        sessionsError: null,
        lastCommitAt: null,
        lastActivityAt: null,
        ...overrides,
    };
}

function kinds(overrides: Partial<WorktreeFacts>): BlockerKind[] {
    return cleanupBlockers(facts(overrides)).map((b) => b.kind);
}

describe("cleanupBlockers: each rule blocks, and its absence does not", () => {
    test("positive control: merged, clean, unused is removable (EMPTY too, ignored files too)", () => {
        expect(kinds({})).toEqual([]);
        expect(kinds({ verdict: "EMPTY", how: "-" })).toEqual([]);
        expect(kinds({ ignored: ["node_modules", ".env"] })).toEqual([]);
    });

    test("merge state: UNMERGED and STALE block, an unknown verdict blocks", () => {
        expect(kinds({ verdict: "UNMERGED", how: "none" })).toEqual(["unmerged"]);
        expect(kinds({ verdict: "STALE", how: "superseded" })).toEqual(["unmerged"]);
        expect(kinds({ verdict: null, verdictError: "no base branch" })).toEqual(["verdict-error"]);
    });

    test("uncommitted work: tracked changes, untracked entries, an unreadable status", () => {
        expect(kinds({ changedCount: 2, changed: ["a.ts", "b.ts"] })).toEqual(["changed"]);
        expect(kinds({ untrackedCount: 1, untracked: ["notes.md"] })).toEqual(["untracked"]);
        expect(kinds({ statusError: "git status failed" })).toEqual(["status-error"]);
    });

    test("stash, running process, recent session, unreadable sessions", () => {
        expect(kinds({ stashes: ["stash@{0}"] })).toEqual(["stash"]);
        expect(kinds({ processes: [{ pid: 7, name: "zsh" }] })).toEqual(["process"]);
        const session = { provider: "claude", sessionId: "s1", title: "fix", mtime: 1 };
        expect(kinds({ sessions: [session] })).toEqual(["session"]);
        expect(kinds({ sessionsError: "index locked" })).toEqual(["session"]);
    });

    test("git state: locked, prunable, folder gone", () => {
        expect(kinds({ locked: "on a USB disk" })).toEqual(["locked"]);
        expect(kinds({ prunable: "gitdir file points to non-existent location" })).toEqual(["missing"]);
        expect(kinds({ present: false })).toEqual(["missing"]);
    });
});

describe("helpers", () => {
    test("stashBranch reads both stash subject forms and ignores detached ones", () => {
        expect(stashBranch("On feat/x: keep this")).toBe("feat/x");
        expect(stashBranch("WIP on feat/y: 1234567 subject")).toBe("feat/y");
        expect(stashBranch("WIP on (no branch): 1234567 subject")).toBeNull();
        expect(stashBranch("autostash")).toBeNull();
    });

    test("parseStashList keeps the ref, the first parent and the branch", () => {
        const parsed = parseStashList(
            "stash@{0}\0aaa bbb\0On feat/x: msg\nstash@{1}\0ccc\0WIP on (no branch): ccc s\n"
        );
        expect(parsed).toEqual([
            { ref: "stash@{0}", firstParent: "aaa", branch: "feat/x" },
            { ref: "stash@{1}", firstParent: "ccc", branch: null },
        ]);
    });

    test("stashesFor: a detached worktree owns only detached stashes on its own commit", () => {
        const head = "c".repeat(40);
        const stashes = parseStashList(
            `stash@{0}\0${head}\0On feat/x: branch work\nstash@{1}\0${head}\0On (no branch): detached work\n`
        );
        expect(stashesFor(stashes, "feat/x", head)).toEqual(["stash@{0}"]);
        expect(stashesFor(stashes, null, head)).toEqual(["stash@{1}"]);
        expect(stashesFor(stashes, null, "d".repeat(40))).toEqual([]);
    });

    test("ownerOf picks the deepest worktree and never a name prefix", () => {
        const all = ["/r", "/r/.worktrees/a", "/r/.worktrees/ab"];
        expect(ownerOf("/r/.worktrees/a/src", all)).toBe("/r/.worktrees/a");
        expect(ownerOf("/r/.worktrees/ab", all)).toBe("/r/.worktrees/ab");
        expect(ownerOf("/r/src", all)).toBe("/r");
        expect(ownerOf("/elsewhere", all)).toBeNull();
    });
});

describe("scan and remove on a scratch repository", () => {
    let repo: TestRepo;
    const wt: Record<string, string> = {};
    let live: LiveUsers;
    let rows: Map<string, WorktreeCleanupRow>;
    let detached: string;
    let detachedStash: string;
    /** A worktree whose folder was moved away, named through a symlink to its parent folder. */
    let goneViaLink: string;
    let goneReal: string;

    beforeAll(async () => {
        repo = await TestRepo.create({ prefix: "gt-hub-wt-" });
        await repo.commitMany({ files: { ".gitignore": "node_modules/\n.env\n" }, message: "ignore" });

        // Merged branches: one squash-merged (content), the rest fast-forward ancestors of master.
        await repo.checkout("feat/squashed", { create: true });
        await repo.commit({ file: "squashed.txt", content: "s\n" });
        await repo.checkout("master");
        await repo.squashMerge("feat/squashed");

        for (const name of ["clean", "dirty", "untracked", "stashed", "busy", "session", "race"]) {
            await repo.branch(`feat/${name}`);
        }

        await repo.checkout("feat/open", { create: true });
        await repo.commit({ file: "open.txt", content: "o\n" });
        await repo.checkout("master");

        for (const name of ["squashed", "clean", "dirty", "untracked", "stashed", "busy", "session", "race", "open"]) {
            wt[name] = await repo.worktreeAdd({ name: `wt-${name}`, ref: `feat/${name}` });
        }

        mkdirSync(join(wt.clean, "node_modules"));
        writeFileSync(join(wt.clean, "node_modules", "x.js"), "x\n");
        writeFileSync(join(wt.clean, ".env"), "SECRET=invented\n");
        writeFileSync(join(wt.dirty, "README.md"), "edited\n");
        writeFileSync(join(wt.untracked, "notes.md"), "draft\n");
        writeFileSync(join(wt.stashed, "README.md"), "to stash\n");
        await repo.git(["stash", "push", "-m", "keep me"], { cwd: wt.stashed });

        // Detached at the commit feat/stashed's stash sits on: that stash is not this worktree's.
        detached = await repo.worktreeAdd({ name: "wt-detached", ref: "master", detach: true });
        // Detached on an older base commit with a stash made on the detached HEAD itself.
        detachedStash = await repo.worktreeAdd({ name: "wt-detached-stash", ref: "master~1", detach: true });
        writeFileSync(join(detachedStash, "README.md"), "detached work\n");
        await repo.git(["stash", "push", "-m", "detached work"], { cwd: detachedStash });

        goneReal = await repo.worktreeAdd({ name: "wt-gone", ref: "feat/clean", detach: true });
        renameSync(goneReal, join(repo.root, "moved-away"));
        const link = join(mkdtempSync(join(tmpdir(), "gt-hub-wt-link-")), "root");
        symlinkSync(repo.root, link);
        goneViaLink = join(link, "wt-gone");

        live = {
            processes: [{ pid: 424242, name: "zsh", cwd: join(wt.busy, "src") }],
            sessions: [{ provider: "claude", sessionId: "sess-1", title: "invented task", mtime: 1, cwd: wt.session }],
            sessionsError: null,
        };
        const report = await scanWorktrees({ repos: [repo.dir], base: "master", live });
        rows = new Map(report.rows.map((row) => [row.path, row]));
    });

    afterAll(() => {
        repo.cleanup();
    });

    test("lists linked worktrees only, never the main checkout", () => {
        expect(rows.size).toBe(12);
        expect(rows.has(repo.dir)).toBe(false);
    });

    test("merged and clean is removable: squash-merged (by content) or empty; ignored files are named", () => {
        expect(rows.get(wt.squashed)?.removable).toBe(true);
        expect(rows.get(wt.squashed)?.verdict).toBe("MERGED");
        expect(rows.get(wt.clean)?.removable).toBe(true);
        expect(rows.get(wt.clean)?.ignored).toEqual([".env", "node_modules"]);
    });

    test("each unsafe worktree is blocked by exactly its own rule", () => {
        const blockedBy = (name: string): BlockerKind[] => rows.get(wt[name])?.blockers.map((b) => b.kind) ?? [];
        expect(blockedBy("open")).toEqual(["unmerged"]);
        expect(blockedBy("dirty")).toEqual(["changed"]);
        expect(blockedBy("untracked")).toEqual(["untracked"]);
        expect(blockedBy("stashed")).toEqual(["stash"]);
        expect(blockedBy("busy")).toEqual(["process"]);
        expect(blockedBy("session")).toEqual(["session"]);
    });

    test("a detached worktree is blocked by its own detached stash only, never by a branch's stash", () => {
        expect(rows.get(detached)?.stashes).toEqual([]);
        expect(rows.get(detached)?.removable).toBe(true);
        expect(rows.get(detachedStash)?.blockers.map((b) => b.kind)).toEqual(["stash"]);
    });

    test("a --base that does not resolve names its cause on every row and fails the list", async () => {
        const report = await scanWorktrees({ repos: [repo.dir], base: "no-such-ref", live, only: [wt.clean] });
        expect(report.rows[0]?.verdictError).toContain("does not resolve");
        expect(unresolvedBase(report, "no-such-ref")).toContain("no-such-ref");
        expect(
            unresolvedBase(
                { ...report, bases: [{ repoRoot: repo.dir, base: "master", source: "flag", detail: "" }] },
                "master"
            )
        ).toBeNull();
        expect(unresolvedBase(report, undefined)).toBeNull();
    });

    test("remove takes only what is still removable, with plain `git worktree remove`", async () => {
        // The race: removable at scan time, stashed on by the time the button is pressed. The tree
        // is clean again, so only the re-check (not git's own refusal) can keep it.
        expect(rows.get(wt.race)?.removable).toBe(true);
        writeFileSync(join(wt.race, "README.md"), "late work\n");
        await repo.git(["stash", "push", "-m", "late work"], { cwd: wt.race });

        const outcomes = await removeWorktrees({
            paths: [...Object.values(wt), detached, detachedStash, goneViaLink],
            base: "master",
            live,
        });
        // A gone folder typed through a symlinked parent is still git's entry, refused as gone.
        const gone = outcomes.find((o) => o.path === goneReal);
        expect(gone?.reasons.join(" ")).toContain("The folder is gone");
        const removed = outcomes.filter((o) => o.removed).map((o) => o.path);
        expect(removed.sort()).toEqual([wt.clean, wt.squashed, detached].sort());
        expect(existsSync(detachedStash)).toBe(true);

        for (const name of ["open", "dirty", "untracked", "stashed", "busy", "session", "race"]) {
            expect(existsSync(wt[name])).toBe(true);
        }

        expect(readFileSync(join(wt.dirty, "README.md"), "utf8")).toBe("edited\n");
        expect(outcomes.find((o) => o.path === wt.race)?.reasons.join(" ")).toContain("A stash names it");
        expect(existsSync(wt.clean)).toBe(false);
        // The branch outlives its worktree.
        expect(await repo.git(["branch", "--list", "feat/clean"])).toContain("feat/clean");
    });
});

describe("the CLI and size doors", () => {
    test("--live-minutes abc is a commander usage error, not a stack trace", async () => {
        const program = new Command().exitOverride().configureOutput({ writeErr: () => {}, writeOut: () => {} });
        registerWorktreesCommand(program);
        const error = await program
            .parseAsync(["worktrees", "list", "--live-minutes", "abc"], { from: "user" })
            .catch((err: unknown) => err);
        expect(error).toBeInstanceOf(CommanderError);
        expect(error).toMatchObject({ code: "commander.invalidArgument" });
    });

    test("size of a folder that does not exist is an error, not a measured 0 bytes", async () => {
        const missing = join(mkdtempSync(join(tmpdir(), "gt-hub-wt-size-")), "gone");
        const [size] = await worktreeSizes([missing]);
        expect(size?.error).toBe("The folder does not exist");
        expect(size?.freeableBytes).toBeNull();
    });
});
