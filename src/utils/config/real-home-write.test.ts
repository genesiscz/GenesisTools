import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { runGit } from "@genesiscz/utils/git/test-repo";
import { _overrideRealHomeWriteForTest, mayPersistMigration } from "./real-home-write";

/**
 * The first version of this check was a silent no-op (it asked `env.tools.getHome()`, which is never falsy), and the
 * second matched path markers that missed 6 of the 7 linked worktrees on this Mac. So every layout below is a REAL
 * git checkout built in a temp folder, and the cases assert that the check SAYS NO, not only that it says yes.
 *
 * Inside `bun test` the preload installs a sandbox home and the process is a test, so the layout cases switch both
 * signals off through the seam; everything after them is the git answer.
 */

let root: string;
const layouts: Record<string, string> = {};

async function git(cwd: string, ...args: string[]): Promise<void> {
    const result = await runGit({ cwd, args });

    if (result.code !== 0) {
        throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr}`);
    }
}

/** The folder this module would live in inside a checkout rooted at `checkout`. */
function codeDirIn(checkout: string): string {
    const dir = join(checkout, "src", "utils", "config");
    mkdirSync(dir, { recursive: true });
    return dir;
}

beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "gt-real-home-write-"));

    const main = join(root, "Projects", "GenesisTools");
    mkdirSync(main, { recursive: true });
    await git(main, "init", "-q");
    await git(main, "commit", "-q", "--allow-empty", "-m", "init");

    const tmpCc = join(root, "cc", "GenesisTools", "session-1", "worktrees", "arch");
    const t3 = join(root, "home", ".t3", "worktrees", "feat-x");
    const claudeMarker = join(main, ".claude", "worktrees", "agent-1");
    await git(main, "worktree", "add", "-q", "--detach", tmpCc);
    await git(main, "worktree", "add", "-q", "--detach", t3);
    await git(main, "worktree", "add", "-q", "--detach", claudeMarker);

    // An independent repository cloned inside the main checkout: its git dir is its own common dir.
    const nested = join(main, "vendor", "inner");
    mkdirSync(nested, { recursive: true });
    await git(nested, "init", "-q");

    layouts.mainCheckout = codeDirIn(main);
    layouts.tmpCcWorktree = codeDirIn(tmpCc);
    layouts.t3Worktree = codeDirIn(t3);
    layouts.claudeMarkerWorktree = codeDirIn(claudeMarker);
    layouts.nestedCheckout = codeDirIn(nested);
    layouts.noGit = codeDirIn(join(root, "plain"));
});

afterAll(() => {
    rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
    env.testing.unset("GENESIS_TOOLS_ALLOW_REAL_MIGRATION");
    env.testing.unset("GIT_DIR");
    _overrideRealHomeWriteForTest(undefined);
});

function verdictFrom(layout: string): ReturnType<typeof mayPersistMigration> {
    _overrideRealHomeWriteForTest({ sandbox: false, testProcess: false, codeDir: layouts[layout] });
    return mayPersistMigration();
}

describe("mayPersistMigration: one case per checkout layout", () => {
    test("a worktree under /tmp/cc/<project>/<session>/worktrees/<name> is refused", () => {
        const verdict = verdictFrom("tmpCcWorktree");

        expect(verdict.allowed).toBe(false);
        expect(verdict.reason).toContain("linked worktree");
    });

    test("a worktree under ~/.t3/worktrees/<name> is refused", () => {
        expect(verdictFrom("t3Worktree").allowed).toBe(false);
    });

    test("a worktree under the main checkout's .claude/worktrees is refused", () => {
        expect(verdictFrom("claudeMarkerWorktree").allowed).toBe(false);
    });

    test("an independent checkout nested inside the main checkout is allowed", () => {
        expect(verdictFrom("nestedCheckout").allowed).toBe(true);
    });

    test("the main checkout is allowed", () => {
        const verdict = verdictFrom("mainCheckout");

        expect(verdict.allowed).toBe(true);
        expect(verdict.reason).toContain("main checkout");
    });

    test("a folder outside any git checkout is allowed", () => {
        const verdict = verdictFrom("noGit");

        expect(verdict.allowed).toBe(true);
        expect(verdict.reason).toContain("not in a git checkout");
    });

    test("a GIT_DIR inherited from an outer git hook does not change the answer", () => {
        env.testing.set("GIT_DIR", join(layouts.mainCheckout, "..", "..", "..", ".git"));

        expect(verdictFrom("t3Worktree").allowed).toBe(false);
        expect(verdictFrom("mainCheckout").allowed).toBe(true);
    });
});

describe("mayPersistMigration: the signals before git", () => {
    test("the preload's sandbox home is always allowed", () => {
        expect(env.tools.hasExplicitHome()).toBe(true);

        const verdict = mayPersistMigration();

        expect(verdict.allowed).toBe(true);
        expect(verdict.reason).toContain("sandbox");
    });

    test("hasExplicitHome is the honest question; getHome always answers yes", () => {
        // getHome() falls back to homedir(), so a truthy check on it can never fail and cannot gate anything.
        env.testing.withOverrides({ GENESIS_TOOLS_HOME: undefined }, () => {
            expect(env.tools.getHome()).toBeTruthy();
            expect(env.tools.hasExplicitHome()).toBe(false);
        });
    });

    test("a test process aimed at the real home is refused, even from the main checkout", () => {
        _overrideRealHomeWriteForTest({ sandbox: false, codeDir: layouts.mainCheckout });

        const verdict = mayPersistMigration();

        expect(verdict.allowed).toBe(false);
        expect(verdict.reason).toContain("test process");
    });

    test("GENESIS_TOOLS_ALLOW_REAL_MIGRATION=1 re-allows a worktree build, and only that variable", () => {
        expect(verdictFrom("tmpCcWorktree").allowed).toBe(false);

        env.testing.set("GENESIS_TOOLS_ALLOW_REAL_MIGRATION", "1");

        expect(verdictFrom("tmpCcWorktree").allowed).toBe(true);
    });
});
