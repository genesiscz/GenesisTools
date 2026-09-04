import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { createGit } from "./core";
import {
    blobMap,
    FOR_EACH_REF_FORMAT,
    isCleanStatus,
    LOG_FORMAT,
    parseCherry,
    parseForEachRef,
    parseLeftRightCount,
    parseLogZ,
    parseLsTreeZ,
    parseMergeTreeZ,
    parseNameStatusZ,
    parseNumstatZ,
    parseRawLogZ,
    parseStatusPorcelainV2Z,
    parseWorktreeList,
    parseWorktreeListZ,
    porcelain,
} from "./porcelain";
import { TestRepo } from "./test-repo";

const repos: TestRepo[] = [];

afterEach(() => {
    for (const repo of repos.splice(0)) {
        repo.cleanup();
    }
});

async function repo(): Promise<TestRepo> {
    const r = await TestRepo.create({ prefix: "gt-porcelain-" });
    repos.push(r);
    return r;
}

describe("fixture parsers", () => {
    it("status v2: header, changed, renamed, unmerged, untracked, ignored", () => {
        const text = [
            "# branch.oid abc",
            "# branch.head feat/x",
            "# branch.upstream origin/feat/x",
            "# branch.ab +2 -1",
            "1 .M N... 100644 100644 100644 aaaa bbbb dir/a b.txt",
            "2 R. N... 100644 100644 100644 cccc cccc R100 new name.txt",
            "old name.txt",
            "u UU N... 100644 100644 100644 100644 dddd eeee ffff conflict.txt",
            "? untracked file",
            "! ignored.log",
        ].join("\0");
        const summary = parseStatusPorcelainV2Z(`${text}\0`);
        expect(summary.branch).toEqual({ oid: "abc", head: "feat/x", upstream: "origin/feat/x", ahead: 2, behind: 1 });
        expect(summary.entries).toEqual([
            { kind: "changed", path: "dir/a b.txt", index: ".", worktree: "M", submodule: "N..." },
            {
                kind: "renamed",
                path: "new name.txt",
                origPath: "old name.txt",
                index: "R",
                worktree: ".",
                submodule: "N...",
                score: 100,
            },
            { kind: "unmerged", path: "conflict.txt", index: "U", worktree: "U", submodule: "N..." },
            { kind: "untracked", path: "untracked file", index: "?", worktree: "?" },
            { kind: "ignored", path: "ignored.log", index: "!", worktree: "!" },
        ]);
        expect(isCleanStatus(summary)).toBe(false);
        expect(isCleanStatus(parseStatusPorcelainV2Z("# branch.oid abc\0! ignored\0"))).toBe(true);
        expect(parseStatusPorcelainV2Z("")).toEqual({ branch: null, entries: [] });
    });

    it("for-each-ref: upstream tracking, gone, head marker", () => {
        // Rows are joined at runtime: a literal "\0" followed by a digit would be an octal escape.
        const row = (fields: string[]): string => fields.join("\0");
        const text = [
            row([
                "refs/heads/master",
                "master",
                "aaaa",
                "commit",
                "origin/master",
                "[ahead 1, behind 2]",
                "170",
                "*",
                "seed",
            ]),
            row(["refs/heads/gone", "gone", "bbbb", "commit", "origin/gone", "[gone]", "160", " ", "x"]),
            row(["refs/heads/local", "local", "cccc", "commit", "", "", "150", " ", "subject with \0 nul"]),
            row(["refs/tags/v1", "v1", "dddd", "tag", "", "", "", " ", "tagged"]),
        ].join("\n");
        const refs = parseForEachRef(`${text}\n`);
        expect(refs[0]).toMatchObject({ name: "master", upstream: "origin/master", ahead: 1, behind: 2, isHead: true });
        expect(refs[1]).toMatchObject({
            name: "gone",
            upstream: "origin/gone",
            upstreamGone: true,
            ahead: null,
            behind: null,
        });
        expect(refs[2]).toMatchObject({
            upstream: null,
            ahead: null,
            subject: "subject with \0 nul",
            committerEpoch: 150,
        });
        expect(refs[3]).toMatchObject({ type: "tag", committerEpoch: 0 });
    });

    it("name-status: renames carry two paths", () => {
        expect(parseNameStatusZ("M\0a b.txt\0R090\0old\0new\0D\0gone\0")).toEqual([
            { status: "M", path: "a b.txt" },
            { status: "R", origPath: "old", path: "new", score: 90 },
            { status: "D", path: "gone" },
        ]);
    });

    it("ls-tree: blobs, trees, sizes, blobMap", () => {
        const entries = parseLsTreeZ(
            `${["100644 blob aaaa\ta b.txt", "040000 tree bbbb\tdir", "100755 blob cccc   12\tdir/x"].join("\0")}\0`
        );
        expect(entries).toEqual([
            { mode: "100644", type: "blob", sha: "aaaa", path: "a b.txt" },
            { mode: "040000", type: "tree", sha: "bbbb", path: "dir" },
            { mode: "100755", type: "blob", sha: "cccc", path: "dir/x", size: 12 },
        ]);
        expect(blobMap(entries)).toEqual(
            new Map([
                ["a b.txt", "aaaa"],
                ["dir/x", "cccc"],
            ])
        );
    });

    it("raw log: commit headers, statuses, renames, tolerant of newline separators", () => {
        const sha = "a".repeat(40);
        const text = `${sha}\0:100644 100644 0000 1111 M\0a.txt\0\n:000000 100644 0000 2222 A\0b c.txt\0:100644 100644 1111 3333 R100\0old\0new\0`;
        const changes = parseRawLogZ(text);
        expect(changes.map((c) => [c.commit === sha, c.status, c.path, c.origPath, c.newSha])).toEqual([
            [true, "M", "a.txt", undefined, "1111"],
            [true, "A", "b c.txt", undefined, "2222"],
            [true, "R", "new", "old", "3333"],
        ]);
    });

    it("numstat: binary dashes and rename form", () => {
        expect(parseNumstatZ(`3\t1\ta b.txt\0-\t-\tblob.dat\0${"5"}\t0\t\0old\0new\0`)).toEqual([
            { path: "a b.txt", insertions: 3, deletions: 1, binary: false },
            { path: "blob.dat", insertions: 0, deletions: 0, binary: true },
            { path: "new", origPath: "old", insertions: 5, deletions: 0, binary: false },
        ]);
    });

    it("cherry, left-right count, worktree list", () => {
        expect(parseCherry("- aaaa first\n+ bbbb second\n")).toEqual([
            { sha: "aaaa", present: true, subject: "first" },
            { sha: "bbbb", present: false, subject: "second" },
        ]);
        expect(parseLeftRightCount("3\t5\n")).toEqual({ ahead: 5, behind: 3 });
        expect(parseLeftRightCount("")).toEqual({ ahead: 0, behind: 0 });
        const wts = parseWorktreeList(
            "worktree /r\nHEAD aaaa\nbranch refs/heads/master\n\nworktree /r/wt\nHEAD bbbb\ndetached\nlocked busy\n\nworktree /r/old\nHEAD cccc\nbranch refs/heads/x\nprunable gitdir file points to non-existent location\n\n"
        );
        expect(wts).toEqual([
            { path: "/r", head: "aaaa", branch: "master", isBare: false, isMain: true, locked: null, prunable: null },
            { path: "/r/wt", head: "bbbb", branch: null, isBare: false, isMain: false, locked: "busy", prunable: null },
            {
                path: "/r/old",
                head: "cccc",
                branch: "x",
                isBare: false,
                isMain: false,
                locked: null,
                prunable: "gitdir file points to non-existent location",
            },
        ]);
    });

    it("worktree list -z: NUL-terminated attributes, empty token ends a record", () => {
        const text = `${[
            "worktree /r",
            "HEAD aaaa",
            "branch refs/heads/master",
            "",
            "worktree /r/wt\nline",
            "HEAD bbbb",
            "detached",
            "locked reason with\nnewline",
            "",
        ].join("\0")}\0`;
        expect(parseWorktreeListZ(text)).toEqual([
            { path: "/r", head: "aaaa", branch: "master", isBare: false, isMain: true, locked: null, prunable: null },
            {
                path: "/r/wt\nline",
                head: "bbbb",
                branch: null,
                isBare: false,
                isMain: false,
                locked: "reason with\nnewline",
                prunable: null,
            },
        ]);
    });

    it("merge-tree: clean and conflicted layouts", () => {
        expect(parseMergeTreeZ("t1\0", 0)).toEqual({ tree: "t1", clean: true, conflictedFiles: [], messages: [] });
        const conflicted = `t2\0a.txt\0b c.txt\0\0${"1"}\0a.txt\0Auto-merging\0Auto-merging a.txt\n\0${"2"}\0a.txt\0b c.txt\0CONFLICT (contents)\0Merge conflict in a.txt\n\0`;
        expect(parseMergeTreeZ(conflicted, 1)).toEqual({
            tree: "t2",
            clean: false,
            conflictedFiles: ["a.txt", "b c.txt"],
            messages: [
                { paths: ["a.txt"], type: "Auto-merging", message: "Auto-merging a.txt" },
                { paths: ["a.txt", "b c.txt"], type: "CONFLICT (contents)", message: "Merge conflict in a.txt" },
            ],
        });
    });

    it("log: NUL-terminated records with multi-line bodies", () => {
        const record = [
            "sha1",
            "s1",
            "p1 p2",
            "An",
            "a@x",
            "1700000000",
            "Cn",
            "c@x",
            "1700000010",
            "subject",
            "body\nmore\n\n",
        ];
        const two = [...record, ...record.map((f) => (f === "sha1" ? "sha2" : f))];
        const commits = parseLogZ(`${two.join("\0")}\0`);
        expect(commits).toHaveLength(2);
        expect(commits[0]).toEqual({
            sha: "sha1",
            shortSha: "s1",
            parents: ["p1", "p2"],
            author: { name: "An", email: "a@x", epoch: 1700000000 },
            committer: { name: "Cn", email: "c@x", epoch: 1700000010 },
            subject: "subject",
            body: "body\nmore",
        });
        expect(commits[1].sha).toBe("sha2");
    });
});

describe("porcelain command bundles", () => {
    it("pair the exact flags a parser needs with that parser", () => {
        expect(porcelain.status.args({ untracked: "no" })).toEqual([
            "status",
            "--porcelain=v2",
            "-z",
            "--branch",
            "--untracked-files=no",
        ]);
        expect(porcelain.status.args()).toContain("--untracked-files=all");
        expect(porcelain.refs.args(["refs/tags/"])).toEqual([
            "for-each-ref",
            `--format=${FOR_EACH_REF_FORMAT}`,
            "refs/tags/",
        ]);
        expect(porcelain.log.args({ range: "a..b", limit: 3, reverse: true, paths: ["x y"] })).toEqual([
            "log",
            "-z",
            LOG_FORMAT,
            "-3",
            "--reverse",
            "a..b",
            "--",
            "x y",
        ]);
        expect(porcelain.nameStatus.args({ from: "a", to: "b", renames: true })).toEqual([
            "diff",
            "--name-status",
            "-z",
            "--find-renames",
            "a",
            "b",
        ]);
        expect(porcelain.lsTree.args({ ref: "HEAD", sizes: true, paths: ["dir"] })).toEqual([
            "ls-tree",
            "-r",
            "-z",
            "--full-tree",
            "-l",
            "HEAD",
            "--",
            "dir",
        ]);
        expect(porcelain.rawChanges.args({ range: "a..b" })).toEqual([
            "log",
            "--raw",
            "-z",
            "--no-abbrev",
            "--diff-merges=first-parent",
            "--no-renames",
            "--format=%H",
            "a..b",
        ]);
        expect(porcelain.numstat.args({ from: "a", to: "b" })).toEqual([
            "diff",
            "--numstat",
            "-z",
            "--no-renames",
            "a",
            "b",
        ]);
        expect(porcelain.cherry.args("up", "head")).toEqual(["cherry", "-v", "up", "head"]);
        expect(porcelain.leftRightCount.args("base", "branch")).toEqual([
            "rev-list",
            "--left-right",
            "--count",
            "base...branch",
        ]);
        expect(porcelain.mergeTree.args("base", "branch")).toEqual([
            "merge-tree",
            "--write-tree",
            "-z",
            "--name-only",
            "--messages",
            "base",
            "branch",
        ]);
        expect(porcelain.worktrees.args()).toEqual(["worktree", "list", "--porcelain", "-z"]);
    });

    it("parse with the same functions the typed readers use", () => {
        expect(porcelain.numstat.parse("1\t2\tf\0")).toEqual([
            { path: "f", insertions: 1, deletions: 2, binary: false },
        ]);
        expect(porcelain.cherry.parse("+ abcd\n")).toEqual([{ sha: "abcd", present: false, subject: undefined }]);
        expect(porcelain.leftRightCount.parse("2\t4")).toEqual({ ahead: 4, behind: 2 });
        expect(porcelain.mergeTree.parse("t\0", 0).clean).toBe(true);
        expect(porcelain.mergeTree.parse("t\0", 1).clean).toBe(false);
        expect(porcelain.worktrees.parse("worktree /r\0HEAD a\0branch refs/heads/m\0\0")[0].branch).toBe("m");
    });
});

describe("createGit typed readers against real git", () => {
    it("status, refs, log, nameStatus, lsTree, rawChanges, numstat, cherry, worktrees, layout", async () => {
        const r = await repo();
        await r.addOrigin();
        await r.checkout("feat/x", { create: true });
        await r.commitMany({
            files: { "dir/ná me.txt": "one\n", "bin.dat": "\0\n" },
            message: "add two files\n\nwith a body",
        });
        await r.git(["mv", "README.md", "READ ME.md"]);
        await r.git(["commit", "-q", "-m", "rename readme"], { epoch: r.tick() });
        r.write({ file: "dir/ná me.txt", content: "two\n" });
        r.write({ file: "untracked.txt", content: "u\n" });
        const wt = await r.worktreeAdd({ name: "wt", ref: "master" });

        const git = createGit({ cwd: r.dir });

        const status = await git.status();
        expect(status.branch).toMatchObject({ head: "feat/x", upstream: null });
        expect(status.entries).toEqual([
            { kind: "changed", path: "dir/ná me.txt", index: ".", worktree: "M", submodule: "N..." },
            { kind: "untracked", path: "untracked.txt", index: "?", worktree: "?" },
        ]);
        expect(isCleanStatus(await git.status({ cwd: wt }))).toBe(true);

        const refs = await git.refs();
        expect(refs.map((x) => x.name)).toEqual(["feat/x", "master"]);
        expect(refs.find((x) => x.name === "master")).toMatchObject({ upstream: "origin/master", ahead: 0, behind: 0 });
        expect(refs.find((x) => x.name === "feat/x")).toMatchObject({
            upstream: null,
            isHead: true,
            subject: "rename readme",
        });

        const log = await git.log({ range: "master..feat/x", reverse: true });
        expect(log.map((c) => c.subject)).toEqual(["add two files", "rename readme"]);
        expect(log[0].body).toBe("with a body");
        expect(log[0].author).toMatchObject({ name: "Test", email: "test@example.com" });
        expect(log[1].parents).toEqual([log[0].sha]);

        expect(await git.nameStatus({ from: "master", to: "feat/x" })).toEqual([
            { status: "A", path: "READ ME.md" },
            { status: "D", path: "README.md" },
            { status: "A", path: "bin.dat" },
            { status: "A", path: "dir/ná me.txt" },
        ]);
        expect(await git.nameStatus({ from: "master", to: "feat/x", renames: true })).toContainEqual({
            status: "R",
            origPath: "README.md",
            path: "READ ME.md",
            score: 100,
        });

        const tree = await git.lsTree({ ref: "feat/x", sizes: true });
        expect(tree.map((e) => e.path)).toEqual(["READ ME.md", "bin.dat", "dir/ná me.txt"]);
        expect(tree[0].size).toBe(5);

        const raw = await git.rawChanges({ range: "master..feat/x", paths: ["dir/ná me.txt", "bin.dat"] });
        expect(raw.map((c) => [c.status, c.path])).toEqual([
            ["A", "bin.dat"],
            ["A", "dir/ná me.txt"],
        ]);
        expect(raw[0].commit).toBe(log[0].sha);
        expect(blobMap(tree).get("dir/ná me.txt")).toBe(raw[1].newSha);

        const stats = await git.numstat({ from: "master", to: "feat/x" });
        expect(stats.find((s) => s.path === "bin.dat")).toMatchObject({ binary: true, insertions: 0 });
        expect(stats.find((s) => s.path === "dir/ná me.txt")).toMatchObject({
            binary: false,
            insertions: 1,
            deletions: 0,
        });

        const cherry = await git.cherry("master", "feat/x");
        expect(cherry.map((c) => [c.present, c.subject])).toEqual([
            [false, "add two files"],
            [false, "rename readme"],
        ]);

        const worktrees = await git.worktrees();
        expect(worktrees.map((w) => [w.branch, w.isMain])).toEqual([
            ["feat/x", true],
            ["master", false],
        ]);

        expect(await git.layout()).toEqual({ repoRoot: r.dir, commonDir: `${r.dir}/.git` });
    });

    it("worktrees survive a newline in a worktree path", async () => {
        const r = await repo();
        await r.branch("side");
        const path = await r.worktreeAdd({ name: "wt\nline", ref: "side" });
        const wts = await createGit({ cwd: r.dir }).worktrees();
        expect(wts.map((w) => [w.path, w.branch])).toEqual([
            [r.dir, "master"],
            [path, "side"],
        ]);
    });

    it("status is read-only: refreshing stale stat data never rewrites the index", async () => {
        const r = await repo();
        const index = join(r.dir, ".git", "index");
        const stale = new Date(Date.now() + 60_000);
        utimesSync(join(r.dir, "README.md"), stale, stale);
        const before = readFileSync(index);

        await createGit({ cwd: r.dir }).status();

        expect(readFileSync(index).equals(before)).toBe(true);
    });

    it("mergeTree reports the net conflicts of two branches without touching the worktree", async () => {
        const r = await repo();
        await r.commit({ file: "a.txt", content: "base\n", message: "a base" });
        await r.checkout("feat/x", { create: true });
        await r.commit({ file: "a.txt", content: "branch\n", message: "a branch" });
        await r.commit({ file: "only.txt", content: "x\n", message: "only on branch" });
        await r.checkout("master");
        await r.commit({ file: "a.txt", content: "master\n", message: "a master" });

        const git = createGit({ cwd: r.dir });
        const result = await git.mergeTree("master", "feat/x");
        expect(result.clean).toBe(false);
        expect(result.conflictedFiles).toEqual(["a.txt"]);
        expect(result.messages.some((m) => m.type.startsWith("CONFLICT") && m.paths.includes("a.txt"))).toBe(true);
        expect(result.tree).toMatch(/^[0-9a-f]{40}$/);
        expect(isCleanStatus(await git.status())).toBe(true);

        await r.checkout("feat/clean", { create: true });
        await r.commit({ file: "c.txt", content: "c\n", message: "c" });
        const clean = await git.mergeTree("master", "feat/clean");
        expect(clean).toMatchObject({ clean: true, conflictedFiles: [], messages: [] });
    });
});
