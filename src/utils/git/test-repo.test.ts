import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyRepoTree, isolatedGitEnv, TestRepo } from "@genesiscz/utils/git/test-repo";
import { skip } from "@genesiscz/utils/test/skip";

const created: TestRepo[] = [];

async function makeRepo(branch: string): Promise<TestRepo> {
    const repo = await TestRepo.create({ branch, prefix: "gt-repo-template-collision-" });
    created.push(repo);

    return repo;
}

afterEach(() => {
    for (const repo of created.splice(0)) {
        repo.cleanup();
    }
});

describe.skipIf(skip.onWindows)("TestRepo template cache", () => {
    /**
     * 🛑 The cache directory name is derived from the shape, and the derivation used to be
     * `shape.replace(/[^a-z0-9]+/gi, "-")`. That collapses BOTH `/` and `-` to the same
     * character, so `feature/a::true` and `feature-a::true` named one directory.
     *
     * The in-process `repoTemplates` Map keys on the full shape, so the second branch missed
     * the cache, rebuilt, and then `cpSync`'d itself over the FIRST branch's template. Every
     * later `feature/a` request was a cache hit on a template that now held `feature-a`, and
     * the caller silently received a repo on the wrong branch.
     *
     * Raised by CodeRabbit on PR #392.
     */
    test("branch names that sanitise alike do not share one template directory", async () => {
        const slash = await makeRepo("feature/a");
        expect((await slash.git(["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("feature/a");

        // Populates the colliding path. Before the fix this overwrote the template above.
        const dash = await makeRepo("feature-a");
        expect((await dash.git(["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("feature-a");

        // A cache HIT for the first shape. It must still be the branch that was cached.
        const again = await makeRepo("feature/a");
        expect((await again.git(["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("feature/a");
    }, 60_000);

    /**
     * The negative control: the cache must still BE a cache. A second repo of an identical
     * shape has to come back correct, or a "fix" that simply disabled caching would pass the
     * case above while quietly making every suite slower.
     */
    test("a repeated shape is served from the template and is still correct", async () => {
        const first = await makeRepo("release/2026");
        const second = await makeRepo("release/2026");

        expect((await second.git(["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("release/2026");
        // The seed commit is copied with the template, so both carry it.
        expect((await second.git(["log", "--oneline"])).trim()).toContain("seed");
        expect(second.dir).not.toBe(first.dir);
    }, 60_000);
});

describe("copyRepoTree", () => {
    test("copies a repository whose .git holds git's fsmonitor socket, leaving the socket out", () => {
        const root = mkdtempSync(join(tmpdir(), "gt-copy-tree-"));
        const from = join(root, "from");
        mkdirSync(join(from, ".git"), { recursive: true });
        writeFileSync(join(from, ".git", "HEAD"), "ref: refs/heads/master\n");
        writeFileSync(join(from, "a.txt"), "a\n");
        const socket = Bun.listen({ unix: join(from, ".git", "fsmonitor--daemon.ipc"), socket: { data() {} } });

        try {
            expect(() => cpSync(from, join(root, "plain"), { recursive: true })).toThrow("socket");

            copyRepoTree(from, join(root, "to"));

            expect(readdirSync(join(root, "to", ".git"))).toEqual(["HEAD"]);
            expect(readFileSync(join(root, "to", "a.txt"), "utf8")).toBe("a\n");
        } finally {
            socket.stop(true);
        }
    });

    test("a regular file or folder with the socket's name is copied like any other entry", () => {
        const root = mkdtempSync(join(tmpdir(), "gt-copy-tree-"));
        const from = join(root, "from");
        mkdirSync(join(from, "docs", "fsmonitor--daemon.ipc"), { recursive: true });
        writeFileSync(join(from, "fsmonitor--daemon.ipc"), "a tracked file\n");
        writeFileSync(join(from, "docs", "fsmonitor--daemon.ipc", "notes.md"), "notes\n");

        copyRepoTree(from, join(root, "to"));

        expect(readFileSync(join(root, "to", "fsmonitor--daemon.ipc"), "utf8")).toBe("a tracked file\n");
        expect(readFileSync(join(root, "to", "docs", "fsmonitor--daemon.ipc", "notes.md"), "utf8")).toBe("notes\n");
    });
});

describe("isolatedGitEnv", () => {
    const run = (cwd: string, args: string[], env: Record<string, string | undefined>) =>
        Bun.spawnSync(["git", "-c", "user.name=Alice", "-c", "user.email=alice@example.com", ...args], {
            cwd,
            env,
            stdout: "pipe",
            stderr: "pipe",
        });
    const commits = (repo: string) =>
        run(repo, ["rev-list", "--all", "--count"], isolatedGitEnv(process.env)).stdout.toString().trim();

    test("a fixture commit stays in the fixture when the run inherits an outer repository's GIT_DIR and index", () => {
        const root = mkdtempSync(join(tmpdir(), "gt-isolated-git-"));
        const outer = join(root, "outer");
        const fixture = join(root, "fixture");

        for (const repo of [outer, fixture]) {
            mkdirSync(repo);
            expect(run(repo, ["init", "-q"], isolatedGitEnv(process.env)).exitCode).toBe(0);
        }

        writeFileSync(join(fixture, "a.txt"), "a\n");
        const inherited = {
            ...process.env,
            GIT_DIR: join(outer, ".git"),
            GIT_INDEX_FILE: join(outer, ".git", "index"),
        };

        // The negative control: with the raw inherited variables the commit lands in the OUTER repository.
        expect(run(fixture, ["add", "a.txt"], inherited).exitCode).toBe(0);
        expect(run(fixture, ["commit", "-qm", "raw"], inherited).exitCode).toBe(0);
        expect([commits(outer), commits(fixture)]).toEqual(["1", "0"]);

        expect(run(fixture, ["add", "a.txt"], isolatedGitEnv(inherited)).exitCode).toBe(0);
        expect(run(fixture, ["commit", "-qm", "isolated"], isolatedGitEnv(inherited)).exitCode).toBe(0);
        expect([commits(outer), commits(fixture)]).toEqual(["1", "1"]);
    });

    test("it drops every repository selector and turns off global and system config", () => {
        const result = isolatedGitEnv({ GIT_DIR: "/x", GIT_WORK_TREE: "/y", GIT_COMMON_DIR: "/z", HOME: "/h" });

        expect(result.GIT_DIR).toBeUndefined();
        expect(result.GIT_WORK_TREE).toBeUndefined();
        expect(result.GIT_COMMON_DIR).toBeUndefined();
        expect(result).toMatchObject({ HOME: "/h", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
    });
});
