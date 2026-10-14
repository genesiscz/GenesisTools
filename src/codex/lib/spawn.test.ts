import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sessionPaths } from "@app/agents/lib/paths";
import { env } from "@genesiscz/utils/env";
import { checkoutKindSync } from "@genesiscz/utils/git/worktree";
import { CODEX_SCHEMA_VERSION } from "./_generated/protocol";
import { sessionLaunchPath } from "./paths";
import {
    assertWritePolicyAllowed,
    parseWritePolicy,
    resolveWritableRoots,
    resolveWritePolicy,
    schemaDriftWarning,
    spawnCodexSession,
    spawnWarnings,
} from "./spawn";
import { CodexSessionStore } from "./store";

describe("schemaDriftWarning", () => {
    const [major, minor, patch] = CODEX_SCHEMA_VERSION.split(".").map(Number);

    test("stays quiet for the snapshot's own version and for any patch release of it", () => {
        expect(schemaDriftWarning(CODEX_SCHEMA_VERSION)).toBeNull();
        expect(schemaDriftWarning(`${major}.${minor}.${(patch ?? 0) + 7}`)).toBeNull();
        expect(schemaDriftWarning(`${major}.${minor}.0`)).toBeNull();
    });

    test("warns when MAJOR.MINOR moves, either way, or the version does not parse", () => {
        expect(schemaDriftWarning(`${major}.${(minor ?? 0) + 1}.0`)).toBe(
            `Installed codex ${major}.${(minor ?? 0) + 1}.0 differs from generated app-server schema ${CODEX_SCHEMA_VERSION}`
        );
        expect(schemaDriftWarning(`${major}.${(minor ?? 0) - 1}.${patch}`)).not.toBeNull();
        expect(schemaDriftWarning(`${(major ?? 0) + 1}.${minor}.${patch}`)).not.toBeNull();
        expect(schemaDriftWarning(`${major}.${minor}1.0`)).not.toBeNull();
        expect(schemaDriftWarning("unknown")).not.toBeNull();
    });
});

describe("resolveWritePolicy", () => {
    test("defaults to a read-only reviewer", () => {
        expect(resolveWritePolicy()).toEqual({
            writePolicy: "deny",
            sandbox: "read-only",
            approvalPolicy: "never",
        });
    });

    test("maps allow and ask to workspace-write with different approvals", () => {
        expect(resolveWritePolicy("allow")).toEqual({
            writePolicy: "allow",
            sandbox: "workspace-write",
            approvalPolicy: "never",
        });
        expect(resolveWritePolicy("ask")).toEqual({
            writePolicy: "ask",
            sandbox: "workspace-write",
            approvalPolicy: "untrusted",
        });
    });

    test("rejects unknown write policies instead of silently using deny", () => {
        expect(parseWritePolicy(undefined)).toBeUndefined();
        expect(parseWritePolicy("ask")).toBe("ask");
        expect(parseWritePolicy("full")).toBe("full");
        expect(() => parseWritePolicy("sometimes")).toThrow("--write must be ask, allow, deny, or full");
    });

    test("maps full to no sandbox and no approvals", () => {
        expect(resolveWritePolicy("full")).toEqual({
            writePolicy: "full",
            sandbox: "danger-full-access",
            approvalPolicy: "never",
        });
    });

    test("keeps explicit deny read-only", () => {
        expect(resolveWritePolicy("deny")).toEqual({
            writePolicy: "deny",
            sandbox: "read-only",
            approvalPolicy: "never",
        });
    });
});

describe("resolveWritableRoots", () => {
    test("grants one agents session without exposing unrelated durable tool state", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-codex-writable-roots-"));
        const explicit = join(home, "explicit");

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, () => {
            const roots = resolveWritableRoots({
                requested: [explicit],
                agentsEnabled: true,
                sandbox: "workspace-write",
                rendezvousSession: "parent-session",
            });
            const selected = sessionPaths("parent-session");

            expect(roots).toEqual([resolve(explicit), selected.sessionDir]);
            expect(existsSync(selected.sessionDir)).toBe(true);
            expect(existsSync(selected.slotsDir)).toBe(true);
            expect(roots).not.toContain(join(home, ".genesis-tools"));
            expect(roots).not.toContain(join(home, ".genesis-tools", "ai"));
            expect(roots).not.toContain(join(home, ".genesis-tools", "security"));
            expect(roots).not.toContain(join(home, ".genesis-tools", "plugins"));
            expect(roots).not.toContain(sessionPaths("other-session").sessionDir);
        });
    });

    test("does not add an implicit root for read-only or agents-disabled workers", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-codex-writable-roots-control-"));
        const explicit = join(home, "explicit");

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, () => {
            expect(
                resolveWritableRoots({
                    requested: [explicit],
                    agentsEnabled: true,
                    sandbox: "read-only",
                    rendezvousSession: "parent-session",
                })
            ).toEqual([resolve(explicit)]);
            expect(
                resolveWritableRoots({
                    requested: [explicit],
                    agentsEnabled: false,
                    sandbox: "workspace-write",
                })
            ).toEqual([resolve(explicit)]);
        });
    });
});

/** A main checkout (`.git` folder) with a linked worktree (`.git` file into `.git/worktrees/<name>`) and a plain folder. */
function checkoutFixture(): { main: string; nested: string; worktree: string; worktreeGitDir: string; plain: string } {
    const root = mkdtempSync(join(tmpdir(), "gt-codex-checkouts-"));
    const main = join(root, "main");
    const worktreeGitDir = join(main, ".git", "worktrees", "wt");
    const worktree = join(root, "wt");
    const nested = join(main, "src", "deep");
    const plain = join(root, "plain");
    mkdirSync(worktreeGitDir, { recursive: true });
    mkdirSync(nested, { recursive: true });
    mkdirSync(worktree, { recursive: true });
    mkdirSync(plain, { recursive: true });
    writeFileSync(join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`);
    return { main, nested, worktree, worktreeGitDir, plain };
}

describe("--write full and the checkout it runs in", () => {
    test("reads a .git folder as a main checkout, from the root and from below it", () => {
        const { main, nested } = checkoutFixture();

        expect(checkoutKindSync(main)).toEqual({ kind: "main", root: main });
        expect(checkoutKindSync(nested)).toEqual({ kind: "main", root: main });
    });

    test("reads a .git file into worktrees/<name> as a linked worktree, any other .git file as main", () => {
        const { worktree, worktreeGitDir, plain } = checkoutFixture();

        expect(checkoutKindSync(worktree)).toEqual({ kind: "linked-worktree", root: worktree, gitDir: worktreeGitDir });

        writeFileSync(join(plain, ".git"), "gitdir: ../main/.git/modules/sub\n");
        expect(checkoutKindSync(plain)).toEqual({ kind: "main", root: plain });
    });

    test("refuses full in a main checkout, naming the worktree fix, and allows it in a worktree or a plain folder", () => {
        const { main, nested, worktree, plain } = checkoutFixture();

        for (const dir of [main, nested]) {
            expect(() => assertWritePolicyAllowed({ write: "full", checkout: checkoutKindSync(dir) })).toThrow(
                `--write full refuses ${main}: it is a main checkout`
            );
        }

        expect(() => assertWritePolicyAllowed({ write: "full", checkout: checkoutKindSync(main) })).toThrow(
            `git -C ${main} worktree add -b <branch> <path>`
        );
        expect(() => assertWritePolicyAllowed({ write: "full", checkout: checkoutKindSync(worktree) })).not.toThrow();
        expect(() => assertWritePolicyAllowed({ write: "full", checkout: checkoutKindSync(plain) })).not.toThrow();

        for (const write of [undefined, "deny", "ask", "allow"] as const) {
            expect(() => assertWritePolicyAllowed({ write, checkout: checkoutKindSync(main) })).not.toThrow();
        }
    });

    test("a refused spawn binds no account, claims no name and writes no launch file", async () => {
        const { main } = checkoutFixture();
        const home = mkdtempSync(join(tmpdir(), "gt-codex-full-refused-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            await expect(
                spawnCodexSession({ name: "full-in-main", cwd: main, write: "full", account: "work", agents: false })
            ).rejects.toThrow("is a main checkout");
            expect(new CodexSessionStore().readMeta("full-in-main")).toBeNull();
            expect(existsSync(sessionLaunchPath("full-in-main"))).toBe(false);
        });
    });
});

describe("spawnWarnings", () => {
    test("full says there is no sandbox, wherever it runs", () => {
        const { worktree, plain } = checkoutFixture();

        for (const dir of [worktree, plain]) {
            expect(spawnWarnings({ write: "full", checkout: checkoutKindSync(dir) })).toEqual([
                "--write full: no sandbox. The worker runs any command as you, with your files, network and credentials.",
            ]);
        }
    });

    test("allow says the worker cannot commit or run ps, and a linked worktree adds where its git data lives", () => {
        const { main, worktree, worktreeGitDir } = checkoutFixture();
        const inMain = spawnWarnings({ write: "allow", checkout: checkoutKindSync(main) });

        expect(inMain).toHaveLength(1);
        expect(inMain[0]).toContain("cannot commit (the sandbox keeps every .git path read-only)");
        expect(inMain[0]).toContain("setuid tools such as ps");

        const inWorktree = spawnWarnings({ write: "allow", checkout: checkoutKindSync(worktree) });
        expect(inWorktree).toHaveLength(2);
        expect(inWorktree[1]).toContain(`cwd is a linked worktree: its git data (${worktreeGitDir})`);
        expect(inWorktree[1]).toContain("Run bun install in the worktree before the spawn.");
    });

    test("ask warns only in a linked worktree, and deny never warns", () => {
        const { main, worktree } = checkoutFixture();

        expect(spawnWarnings({ write: "ask", checkout: checkoutKindSync(main) })).toEqual([]);
        expect(spawnWarnings({ write: "ask", checkout: checkoutKindSync(worktree) })).toHaveLength(1);
        expect(spawnWarnings({ write: "deny", checkout: checkoutKindSync(worktree) })).toEqual([]);
        expect(spawnWarnings({ checkout: checkoutKindSync(worktree) })).toEqual([]);
    });
});
