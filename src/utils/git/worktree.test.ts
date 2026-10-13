import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    getMainRepoRootSync,
    listWorktrees,
    resolveWorktreeBasePath,
    worktreeByBranch,
} from "@genesiscz/utils/git/worktree";

/** `getMainRepoRootSync` answers "which checkout owns this directory" for two
 *  consumers that resolve durable state from it: the clones daemon registers
 *  the script path of the MAIN checkout (a worktree is deleted a week later),
 *  and `~/.claude/projects/` lookups encode that path. Both break silently on
 *  a wrong answer, so the contract is pinned here against real git. */
describe("getMainRepoRootSync", () => {
    let outer: string;
    let main: string;
    let worktree: string;

    const git = (cwd: string, ...args: string[]): void => {
        execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    };

    beforeAll(() => {
        outer = realpathSync(mkdtempSync(join(tmpdir(), "gt-worktree-")));
        main = join(outer, "main");
        worktree = join(outer, "linked");
        mkdirSync(main, { recursive: true });
        git(main, "init", "-b", "main");
        git(main, "config", "user.email", "tester@example.com");
        git(main, "config", "user.name", "Tester");
        writeFileSync(join(main, "README.md"), "seed\n");
        git(main, "add", "README.md");
        git(main, "commit", "-m", "seed");
        git(main, "worktree", "add", "-b", "side", worktree);
        mkdirSync(join(main, "src", "deep"), { recursive: true });
        mkdirSync(join(worktree, "src", "deep"), { recursive: true });
    });

    afterAll(() => {
        rmSync(outer, { recursive: true, force: true });
    });

    it("returns the checkout root from the main checkout root", () => {
        expect(getMainRepoRootSync(main)).toBe(main);
    });

    it("returns the checkout root from a subdirectory of the main checkout", () => {
        // The two-query form returned the subdirectory itself here, so the
        // daemon registered a script path that does not exist.
        expect(getMainRepoRootSync(join(main, "src", "deep"))).toBe(main);
    });

    it("returns the MAIN checkout root from a linked worktree", () => {
        expect(getMainRepoRootSync(worktree)).toBe(main);
    });

    it("returns the MAIN checkout root from a subdirectory of a linked worktree", () => {
        expect(getMainRepoRootSync(join(worktree, "src", "deep"))).toBe(main);
    });

    it("listWorktrees keeps a newline inside a worktree path", async () => {
        const path = join(outer, "wt\nline");
        git(main, "worktree", "add", "-b", "newline", path);
        const listed = await listWorktrees(main);
        expect(listed.map((w) => [w.path, w.branch, w.isMain])).toEqual([
            [main, "main", true],
            [worktree, "side", false],
            [path, "newline", false],
        ]);
    });

    it("returns the directory unchanged outside any repository", () => {
        const plain = realpathSync(mkdtempSync(join(tmpdir(), "gt-norepo-")));
        try {
            expect(getMainRepoRootSync(plain)).toBe(plain);
        } finally {
            rmSync(plain, { recursive: true, force: true });
        }
    });
});

describe("worktreeByBranch", () => {
    it("maps each branch to its worktree; the main checkout loses a tie and a bare entry is skipped", () => {
        const byBranch = worktreeByBranch([
            { path: "/work/app", head: "a", branch: "feat/x", isBare: false, isMain: true },
            { path: "/work/app-x", head: "a", branch: "feat/x", isBare: false, isMain: false },
            { path: "/work/app-y", head: "b", branch: "feat/y", isBare: false, isMain: false },
            { path: "/work/app.git", head: "c", branch: "main", isBare: true, isMain: false },
            { path: "/work/app-detached", head: "d", branch: null, isBare: false, isMain: false },
        ]);

        expect([...byBranch]).toEqual([
            ["feat/x", "/work/app-x"],
            ["feat/y", "/work/app-y"],
        ]);
    });
});

describe("resolveWorktreeBasePath", () => {
    let repo: string;
    let gitignore: string;

    beforeEach(() => {
        repo = realpathSync(mkdtempSync(join(tmpdir(), "gt-worktree-base-")));
        gitignore = join(repo, ".gitignore");
    });

    afterEach(() => {
        rmSync(repo, { recursive: true, force: true });
    });

    // Write-only (0200): reading fails with EACCES while a write would still succeed, which is exactly
    // when the old code appended the pattern to "" and replaced every line the user had.
    it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
        "a .gitignore that cannot be read is left byte-identical instead of being replaced by one line",
        async () => {
            const original = "node_modules/\n.env\ndist/\n";
            writeFileSync(gitignore, original);
            chmodSync(gitignore, 0o200);

            try {
                await expect(resolveWorktreeBasePath(repo)).rejects.toThrow(gitignore);
            } finally {
                chmodSync(gitignore, 0o644);
            }

            expect(readFileSync(gitignore, "utf8")).toBe(original);
        }
    );

    it("a readable .gitignore keeps every line and gains the pattern once", async () => {
        writeFileSync(gitignore, "node_modules/\n.env");

        expect(await resolveWorktreeBasePath(repo)).toBe(join(repo, ".claude", "worktrees"));
        expect(readFileSync(gitignore, "utf8")).toBe("node_modules/\n.env\n.claude/worktrees/\n");

        await resolveWorktreeBasePath(repo);
        expect(readFileSync(gitignore, "utf8")).toBe("node_modules/\n.env\n.claude/worktrees/\n");
    });

    it("a missing .gitignore is created with the pattern", async () => {
        expect(await resolveWorktreeBasePath(repo)).toBe(join(repo, ".claude", "worktrees"));
        expect(readFileSync(gitignore, "utf8")).toBe("\n.claude/worktrees/\n");
    });
});
