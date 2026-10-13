import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { withSpawnCounter } from "@app/benchmark/lib";
import { env } from "@genesiscz/utils/env";
import {
    type AgentProcess,
    clearStaleWorktreeLocks,
    findStaleWorktreeLocks,
    isLockStale,
    linkedWorktreeOf,
    lockWorktreeAtSessionStart,
    lockWorktreesForPaths,
    lockWorktreesForToolUse,
    parseLockReason,
    readLockReason,
    shellCommandPaths,
    unlockSessionWorktrees,
} from "./worktree-lock";

// One repository with one linked worktree for the whole file: three git spawns. Each test sets the
// lock state by writing git's own `locked` file, which costs no spawn.
const base = realpathSync(mkdtempSync(join(tmpdir(), "worktree-lock-")));
const main = join(base, "main");
const wt = join(base, "wt");
const admin = join(main, ".git", "worktrees", "wt");
const me: AgentProcess = { harness: "claude", pid: process.pid };
/** Above the macOS pid ceiling (99998), so no process ever has it. */
const DEAD_PID = 999999;
const DEAD_LOCK = `claude session gone-session pid ${DEAD_PID} since 2026-10-01T10:00:00.000Z`;

function git(args: string[]): void {
    const result = Bun.spawnSync(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
        cwd: base,
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
        stderr: "pipe",
    });

    if (result.exitCode !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
    }
}

function plantLock(reason: string): void {
    writeFileSync(join(admin, "locked"), `${reason}\n`);
}

function lockReason(): string | null {
    return readLockReason(admin);
}

function edit(sessionId: string, file: string): object {
    return {
        session_id: sessionId,
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: { file_path: file },
        tool_response: { success: true },
        cwd: main,
    };
}

function bash(sessionId: string, command: string): object {
    return {
        session_id: sessionId,
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command },
        cwd: main,
    };
}

beforeAll(() => {
    git(["init", "-q", "-b", "main", "main"]);
    git(["-C", "main", "commit", "-q", "--allow-empty", "-m", "init"]);
    git(["-C", "main", "worktree", "add", "-q", "--detach", "../wt"]);
});

beforeEach(() => {
    if (existsSync(join(admin, "locked"))) {
        unlinkSync(join(admin, "locked"));
    }
});

afterAll(() => {
    rmSync(base, { recursive: true, force: true });
});

describe("worktree-lock", () => {
    it("an edit inside a linked worktree locks it for the session, and a repeat edit spawns nothing", async () => {
        lockWorktreesForToolUse(edit("s-edit", join(wt, "a.ts")), { agent: me });

        expect(lockReason()).toMatch(/^claude session s-edit pid \d+ since \d{4}-\d\d-\d\dT[\d:.]+Z$/);
        expect(parseLockReason(lockReason() ?? "")).toMatchObject({
            kind: "session",
            sessionId: "s-edit",
            pid: me.pid,
        });

        const again = await withSpawnCounter(async () =>
            lockWorktreesForToolUse(edit("s-edit", join(wt, "b.ts")), { agent: me })
        );
        expect(again.count).toBe(0);
    });

    it("never locks the main checkout, and finding that out spawns nothing", async () => {
        const run = await withSpawnCounter(async () =>
            lockWorktreesForPaths({ sessionId: "s-main", paths: [join(main, "a.ts"), main], agent: me })
        );

        expect(run.count).toBe(0);
        expect(run.result.size).toBe(0);
        expect(existsSync(join(main, ".git", "locked"))).toBe(false);
        expect(lockReason()).toBeNull();
        expect(linkedWorktreeOf(join(wt, "not", "there", "yet.ts"))?.root).toBe(wt);
    });

    it("never steals: another live session's lock, Claude Code's own lock and a hand lock stay as they are", () => {
        const reasons = [
            `codex session other-session pid ${me.pid} since ${new Date().toISOString()}`,
            `claude agent a1b2c3 (pid ${me.pid} start Mon Oct 13 20:00:00 2026)`,
            "parked for the release, do not remove",
        ];

        for (const reason of reasons) {
            plantLock(reason);

            expect(lockWorktreesForPaths({ sessionId: "s-thief", paths: [wt], agent: me }).get(wt)).toBe("held");
            expect(lockReason()).toBe(reason);
        }
    });

    it("a dead session's lock is stale: found without a change, cleared, and taken over by the next call", () => {
        plantLock(DEAD_LOCK);

        expect(findStaleWorktreeLocks(wt).map((lock) => lock.reason)).toEqual([DEAD_LOCK]);
        expect(lockReason()).toBe(DEAD_LOCK);
        expect(clearStaleWorktreeLocks(main).map((lock) => lock.root)).toEqual([wt]);
        expect(lockReason()).toBeNull();

        plantLock(DEAD_LOCK);
        lockWorktreesForToolUse(bash("s-heir", `git -C ${wt} status`), { agent: me });

        expect(parseLockReason(lockReason() ?? "")).toMatchObject({ kind: "session", sessionId: "s-heir" });
    });

    it("a live pid that started after the lock was taken is a reused pid, so its lock is stale", () => {
        expect(isLockStale(parseLockReason(`claude session old pid ${me.pid} since 2000-01-01T00:00:00.000Z`))).toBe(
            true
        );
        expect(isLockStale(parseLockReason(`claude session now pid ${me.pid} since ${new Date().toISOString()}`))).toBe(
            false
        );
        expect(isLockStale(parseLockReason(`claude session x (pid ${DEAD_PID})`))).toBe(true);
        expect(isLockStale(parseLockReason("parked for the release"))).toBe(false);
    });

    it("SessionEnd unlocks only this session's locks and drops its record", () => {
        lockWorktreesForPaths({ sessionId: "s-end", paths: [wt], agent: me });
        const record = join(
            env.getTrimmed("GENESIS_TOOLS_HOME") ?? homedir(),
            ".genesis-tools",
            "claude-code",
            "worktree-locks",
            "s-end.json"
        );

        expect(existsSync(record)).toBe(true);
        expect(unlockSessionWorktrees("s-other")).toEqual([]);
        expect(parseLockReason(lockReason() ?? "")).toMatchObject({ sessionId: "s-end" });
        expect(unlockSessionWorktrees("s-end")).toEqual([wt]);
        expect(lockReason()).toBeNull();
        expect(existsSync(record)).toBe(false);
    });

    it("a Bash command that names no path inside a linked worktree runs no git", async () => {
        const quiet = await withSpawnCounter(async () =>
            lockWorktreesForToolUse(
                bash("s-bash", `ls /usr/bin && cat ${join(main, "x.md")} ~/notes https://example.com/a/b`),
                {
                    agent: me,
                }
            )
        );

        expect(quiet.count).toBe(0);
        expect(lockReason()).toBeNull();

        // Positive control: the same call naming the worktree spawns exactly the lock.
        const named = await withSpawnCounter(async () =>
            lockWorktreesForToolUse(bash("s-bash", `cd ${wt} && git status`), { agent: me })
        );

        expect(named.count).toBe(1);
        expect(parseLockReason(lockReason() ?? "")).toMatchObject({ sessionId: "s-bash" });
    });

    it("reads only absolute paths out of a shell command", () => {
        expect(shellCommandPaths("git -C /a/b status --git-dir=/c/d; cat ~/e 'https://x.y/z' src/rel")).toEqual([
            "/a/b",
            "/c/d",
            join(homedir(), "e"),
        ]);
        expect(shellCommandPaths("echo hello")).toEqual([]);
    });

    it("SessionStart in a linked worktree (Grok's envelope) clears the stale lock and locks it", () => {
        plantLock(DEAD_LOCK);

        const outcome = lockWorktreeAtSessionStart(
            { sessionId: "s-start", hookEventName: "session_start", cwd: join(wt, "src") },
            { agent: me }
        );

        expect(outcome.get(wt)).toBe("locked");
        expect(parseLockReason(lockReason() ?? "")).toMatchObject({ kind: "session", sessionId: "s-start" });
    });
});
