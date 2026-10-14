import { dlopen, FFIType } from "bun:ffi";
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import {
    closeSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    openSync,
    realpathSync,
    rmSync,
    symlinkSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
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
    releaseSessionWorktree,
    shellCommandPaths,
    unlockSessionWorktrees,
} from "./worktree-lock";

// Two repositories let record tests exercise independent writers without rebuilding fixtures per test.
const base = realpathSync(mkdtempSync(join(tmpdir(), "worktree-lock-")));
const main = join(base, "main");
const wt = join(base, "wt");
const admin = join(main, ".git", "worktrees", "wt");
const otherMain = join(base, "other-main");
const otherWt = join(base, "other-wt");
const otherAdmin = join(otherMain, ".git", "worktrees", "other-wt");
/** A stand-in agent: `sleep` started through a link named `claude`, so `ps` shows an agent program at its pid. */
const agentLink = join(base, "claude");
symlinkSync("/bin/sleep", agentLink);
const fakeAgent = Bun.spawn([agentLink, "600"], { env: process.env, stdout: "ignore", stderr: "ignore" });
const me: AgentProcess = { harness: "claude", pid: fakeAgent.pid };
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
    git(["init", "-q", "-b", "main", "other-main"]);
    git(["-C", "other-main", "commit", "-q", "--allow-empty", "-m", "init"]);
    git(["-C", "other-main", "worktree", "add", "-q", "--detach", "../other-wt"]);
});

beforeEach(() => {
    for (const directory of [admin, otherAdmin]) {
        if (existsSync(join(directory, "locked"))) {
            unlinkSync(join(directory, "locked"));
        }

        rmSync(join(directory, "session-users"), { recursive: true, force: true });
    }
});

afterAll(() => {
    fakeAgent.kill();
    rmSync(base, { recursive: true, force: true });
});

describe("releaseSessionWorktree", () => {
    // Its own worktree: a removal must not take away the `wt` every other test uses.
    const wt2 = join(base, "wt2");
    const admin2 = join(main, ".git", "worktrees", "wt2");
    const ours = `claude session s-rel pid ${DEAD_PID} since 2026-10-14T00:00:00.000Z`;

    it("removes only a worktree whose lock is this session's, and keeps the lock when git refuses", () => {
        git(["-C", "main", "worktree", "add", "-q", "--detach", "../wt2"]);
        writeFileSync(join(admin2, "locked"), `${ours}\n`);

        // Another session's id: refused, nothing changes.
        expect(releaseSessionWorktree({ worktree: wt2, sessionId: "s-other" })).toMatchObject({ removed: false });
        expect(readLockReason(admin2)).toBe(ours);

        // An untracked file: git refuses the plain remove, and the same lock goes back.
        writeFileSync(join(wt2, "scratch.txt"), "x\n");
        const refused = releaseSessionWorktree({ worktree: wt2, sessionId: "s-rel" });
        expect(refused.removed).toBe(false);
        expect(refused.detail).toContain("lock kept");
        expect(readLockReason(admin2)).toBe(ours);
        expect(existsSync(wt2)).toBe(true);

        // Clean and ours: removed.
        unlinkSync(join(wt2, "scratch.txt"));
        expect(releaseSessionWorktree({ worktree: wt2, sessionId: "s-rel" })).toMatchObject({ removed: true });
        expect(existsSync(wt2)).toBe(false);
        expect(existsSync(admin2)).toBe(false);
    });

    it("unexpected CLI exceptions fail, while the hook stays fail-open", () => {
        mkdirSync(join(admin, "locked"));
        const script = join(import.meta.dir, "worktree-lock.ts");

        try {
            const cli = Bun.spawnSync(["bun", script, "release", wt, "--session", "cli-error"], {
                env: process.env,
                stdout: "pipe",
                stderr: "pipe",
            });
            expect(cli.exitCode).toBe(1);
            const hook = Bun.spawnSync(["bun", script], {
                env: process.env,
                stdout: "pipe",
                stderr: "pipe",
                stdin: new TextEncoder().encode(
                    JSON.stringify({ session_id: "hook-error", hook_event_name: "SessionStart", cwd: wt })
                ),
            });
            expect(hook.exitCode).toBe(0);
        } finally {
            rmSync(join(admin, "locked"), { recursive: true });
        }
    });

    it("the release verb exits 1 when it removed nothing, so a script cannot read a refusal as success", () => {
        const run = Bun.spawnSync(
            [
                "bun",
                join(import.meta.dir, "worktree-lock.ts"),
                "release",
                join(base, "not-a-worktree"),
                "--session",
                "s-rel",
            ],
            { env: process.env, stdout: "pipe", stderr: "pipe" }
        );

        expect(run.exitCode).toBe(1);
        expect(run.stdout.toString()).toContain('"removed":false');
    });
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

        const writes = spyOn(fs, "writeFileSync");

        try {
            const again = await withSpawnCounter(async () =>
                lockWorktreesForToolUse(edit("s-edit", join(wt, "b.ts")), { agent: me })
            );
            expect(again.count).toBe(0);
            expect(writes).not.toHaveBeenCalled();
        } finally {
            writes.mockRestore();
        }
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

    it("serializes two owners taking over a stale lock and stale clearing", () => {
        plantLock(DEAD_LOCK);
        const libc = dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
            flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
        });
        const fd = openSync(join(admin, "session-lock.flock"), "a", 0o600);

        try {
            expect(libc.symbols.flock(fd, 2 | 4)).toBe(0);
            expect(lockWorktreesForPaths({ sessionId: "owner-b", paths: [wt], agent: me }).get(wt)).toBe("held");
            expect(clearStaleWorktreeLocks(main)).toEqual([]);
            expect(lockReason()).toBe(DEAD_LOCK);
        } finally {
            closeSync(fd);
            libc.close();
        }

        expect(lockWorktreesForPaths({ sessionId: "owner-a", paths: [wt], agent: me }).get(wt)).toBe("locked");
        const liveReason = lockReason();
        expect(lockWorktreesForPaths({ sessionId: "owner-b", paths: [wt], agent: me }).get(wt)).toBe("held");
        expect(clearStaleWorktreeLocks(main)).toEqual([]);
        expect(lockReason()).toBe(liveReason);
    });

    it("keeps a session lock while another ownership transition holds the guard", () => {
        lockWorktreesForPaths({ sessionId: "owner-end", paths: [wt], agent: me });
        const liveReason = lockReason();
        const libc = dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
            flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
        });
        const fd = openSync(join(admin, "session-lock.flock"), "a", 0o600);
        const dirty = join(wt, "keep-fixture.txt");
        writeFileSync(dirty, "A planted regression must not remove the shared fixture.");

        try {
            expect(libc.symbols.flock(fd, 2 | 4)).toBe(0);
            const released = releaseSessionWorktree({ worktree: wt, sessionId: "owner-end" });
            expect(released.removed).toBe(false);
            expect(released.detail).toContain("guard is busy");
            expect(unlockSessionWorktrees("owner-end")).toEqual([]);
            expect(lockReason()).toBe(liveReason);
            expect(existsSync(wt)).toBe(true);
        } finally {
            closeSync(fd);
            libc.close();
        }

        unlinkSync(dirty);
        expect(unlockSessionWorktrees("owner-end")).toEqual([wt]);
        expect(lockReason()).toBeNull();
    });

    it("registers a second session when a busy guard is released within the retry bound", async () => {
        lockWorktreesForPaths({ sessionId: "retry-first", paths: [wt], agent: me });
        const libc = dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
            flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
        });
        const fd = openSync(join(admin, "session-lock.flock"), "a", 0o600);
        let worker: Worker | undefined;
        let released = false;

        try {
            expect(libc.symbols.flock(fd, 2 | 4)).toBe(0);
            worker = new Worker(
                `
                const { parentPort, workerData } = require("node:worker_threads");
                import(workerData.module).then(({ lockWorktreesForPaths }) => {
                    const wait = Atomics.wait;
                    Atomics.wait = (...args) => {
                        parentPort.postMessage({ waiting: true });
                        return wait(...args);
                    };
                    const outcome = lockWorktreesForPaths(workerData.options).get(workerData.root);
                    parentPort.postMessage({ outcome });
                    parentPort.close();
                }).catch((error) => { throw error; });
            `,
                {
                    eval: true,
                    env: process.env,
                    workerData: {
                        module: join(import.meta.dir, "worktree-lock.ts"),
                        root: wt,
                        options: { sessionId: "retry-second", paths: [wt], agent: me },
                    },
                }
            );
            const registration = worker;
            const outcome = await new Promise<string>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error("registration worker timed out")), 3000);
                registration.on("error", (error) => {
                    clearTimeout(timer);
                    reject(error);
                });
                registration.on("message", (message: { waiting?: boolean; outcome?: string }) => {
                    if (message.waiting && !released) {
                        if (libc.symbols.flock(fd, 8) !== 0) {
                            clearTimeout(timer);
                            reject(new Error("test could not release its guard"));
                            return;
                        }

                        released = true;
                    }

                    if (message.outcome) {
                        clearTimeout(timer);
                        resolve(message.outcome);
                    }
                });
            });
            expect(outcome).toBe("held");
            expect(released).toBe(true);
            expect(existsSync(join(admin, "session-users", "retry-second.json"))).toBe(true);
            expect(unlockSessionWorktrees("retry-first")).toEqual([]);
            expect(parseLockReason(lockReason() ?? "")).toMatchObject({ sessionId: "retry-second", pid: me.pid });
            expect(unlockSessionWorktrees("retry-second")).toEqual([wt]);
        } finally {
            await worker?.terminate();
            closeSync(fd);
            libc.close();
        }
    });

    it("reports held after the bounded retry when the guard stays busy, without spawning", () => {
        lockWorktreesForPaths({ sessionId: "timeout-first", paths: [wt], agent: me });
        const reason = lockReason();
        const libc = dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
            flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
        });
        const fd = openSync(join(admin, "session-lock.flock"), "a", 0o600);
        const spawn = spyOn(Bun, "spawnSync");
        const wait = spyOn(Atomics, "wait");

        try {
            expect(libc.symbols.flock(fd, 2 | 4)).toBe(0);
            const started = performance.now();
            const result = lockWorktreesForPaths({ sessionId: "timeout-second", paths: [wt], agent: me });
            const elapsed = performance.now() - started;
            expect(result.get(wt)).toBe("held");
            expect(elapsed).toBeGreaterThanOrEqual(900);
            expect(elapsed).toBeLessThan(3000);
            expect(wait).toHaveBeenCalled();
            expect(spawn).not.toHaveBeenCalled();
            expect(lockReason()).toBe(reason);
            expect(existsSync(join(admin, "session-users", "timeout-second.json"))).toBe(false);
        } finally {
            wait.mockRestore();
            spawn.mockRestore();
            closeSync(fd);
            libc.close();
        }
    });

    it("checks one owner through the kernel without spawning a process", async () => {
        const reason = `claude session single pid ${me.pid} since ${new Date().toISOString()}`;
        const check = await withSpawnCounter(async () => isLockStale(parseLockReason(reason)));
        expect(check.result).toBe(false);
        expect(check.count).toBe(0);
        expect(check.spawns).toEqual([]);
    });

    it("a stale scan uses kernel reads without spawning and agrees with single-owner checks for live, dead, reused and repeated PIDs", async () => {
        const now = Date.now();
        const reasons = [
            DEAD_LOCK,
            `claude session live pid ${me.pid} since ${new Date(now).toISOString()}`,
            `claude session reused pid ${me.pid} since 2000-01-01T00:00:00.000Z`,
            `claude session live-again pid ${me.pid} since ${new Date(now).toISOString()}`,
        ];
        const directories = [
            admin,
            ...["scan-live", "scan-reused", "scan-live-again"].map((name) => join(main, ".git", "worktrees", name)),
        ];

        for (const [index, directory] of directories.entries()) {
            if (index > 0) {
                mkdirSync(directory);
                writeFileSync(join(directory, "gitdir"), join(base, `scan-${index}`, ".git"));
            }

            writeFileSync(join(directory, "locked"), reasons[index]!);
        }

        try {
            const individual = reasons.map((reason) => isLockStale(parseLockReason(reason)));
            expect(individual).toEqual([true, false, true, false]);
            const scan = await withSpawnCounter(async () => findStaleWorktreeLocks(main));
            expect(scan.count).toBe(0);
            const stale = new Set(scan.result.map((lock) => lock.adminDir));
            expect(directories.map((directory) => stale.has(directory))).toEqual(individual);
        } finally {
            for (const directory of directories.slice(1)) {
                rmSync(directory, { recursive: true });
            }
        }
    });

    it("merged followup: stale inspection excludes a live registered survivor using one process scan", async () => {
        lockWorktreesForPaths({ sessionId: "stale-survivor", paths: [wt], agent: me });
        plantLock(DEAD_LOCK);
        const scan = await withSpawnCounter(async () => findStaleWorktreeLocks(main));
        expect(scan.result).toEqual([]);
        // Owners are read from the kernel (readProcessBasics): the scan spawns no process at all.
        expect(scan.count).toBe(0);
        expect(lockReason()).toBe(DEAD_LOCK);
        expect(clearStaleWorktreeLocks(main)).toEqual([]);
        expect(parseLockReason(lockReason() ?? "")).toMatchObject({ sessionId: "stale-survivor" });
        expect(unlockSessionWorktrees("stale-survivor")).toEqual([wt]);
    });

    it("merged followup: SessionEnd preserves retry records when unlock or handoff fails", () => {
        const spawnSync = Bun.spawnSync;
        const unlink = fs.unlinkSync;
        const rename = fs.renameSync;
        const failure = spawnSync(["git", "--invalid-fixture-option"], { env: process.env, stderr: "pipe" });

        for (const mode of ["unlock", "handoff"]) {
            const session = `retry-${mode}`;
            lockWorktreesForPaths({ sessionId: session, paths: [wt, otherWt], agent: me });
            if (mode === "handoff") {
                lockWorktreesForPaths({ sessionId: "handoff-survivor", paths: [wt], agent: me });
            }
            const reason = lockReason();
            const shards = join(
                env.getTrimmed("GENESIS_TOOLS_HOME") ?? homedir(),
                ".genesis-tools",
                "claude-code",
                "worktree-locks",
                `${session}.json.d`
            );
            const locked = join(admin, "locked");
            const spawn = spyOn(Bun, "spawnSync").mockImplementation((command, options) => {
                if (Array.isArray(command) && command[0] === "git" && command[3] === "unlock" && command[4] === wt) {
                    return failure;
                }
                return Array.isArray(command) ? spawnSync(command, options) : spawnSync(command);
            });
            const remove = spyOn(fs, "unlinkSync").mockImplementation((file) => {
                if (mode === "unlock" && file === locked) {
                    throw new Error("fixture denied lock unlink");
                }
                unlink(file);
            });
            const publish = spyOn(fs, "renameSync").mockImplementation((from, to) => {
                if (mode === "handoff" && to === locked) {
                    throw new Error("fixture denied handoff rename");
                }
                rename(from, to);
            });
            let ended: string[] | undefined;
            let error: unknown;
            try {
                ended = unlockSessionWorktrees(session);
            } catch (caught) {
                error = caught;
            } finally {
                spawn.mockRestore();
                remove.mockRestore();
                publish.mockRestore();
            }
            expect(error).toBeUndefined();
            expect(ended).toEqual([otherWt]);
            expect(lockReason()).toBe(reason);
            expect(existsSync(shards)).toBe(true);
            expect(fs.readdirSync(shards)).toHaveLength(1);
            const retried = unlockSessionWorktrees(session);
            expect(retried).toEqual(mode === "unlock" ? [wt] : []);
            if (mode === "handoff") {
                expect(parseLockReason(lockReason() ?? "")).toMatchObject({ sessionId: "handoff-survivor" });
                expect(unlockSessionWorktrees("handoff-survivor")).toEqual([wt]);
            }
            expect(lockReason()).toBeNull();
            expect(existsSync(shards)).toBe(false);
        }
    });

    it("merged followup: failed Git restoration recovers exclusively or reports the unprotected lock", () => {
        const spawnSync = Bun.spawnSync;
        const write = fs.writeFileSync;
        const failure = spawnSync(["git", "--invalid-fixture-option"], { env: process.env, stderr: "pipe" });
        const dirty = join(wt, "restoration-fixture.txt");
        writeFileSync(dirty, "git must refuse removal of this fixture");
        const locked = join(admin, "locked");
        try {
            for (const mode of ["recover", "denied", "foreign"]) {
                const reason = `claude session restore-owner pid ${me.pid} since ${new Date().toISOString()}`;
                plantLock(reason);
                const spawn = spyOn(Bun, "spawnSync").mockImplementation((command, options) => {
                    if (Array.isArray(command) && command[0] === "git" && command[3] === "lock") {
                        if (mode === "foreign") {
                            write(locked, "manual protection\n");
                        }
                        return failure;
                    }
                    return Array.isArray(command) ? spawnSync(command, options) : spawnSync(command);
                });
                const persist = spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
                    if (file === locked && mode === "denied") {
                        throw new Error("fixture denied lock restoration");
                    }
                    write(file, data, options);
                });
                try {
                    const result = releaseSessionWorktree({ worktree: wt, sessionId: "restore-owner" });
                    expect(result.removed).toBe(false);
                    expect(existsSync(wt)).toBe(true);
                    if (mode === "recover") {
                        expect(lockReason()).toBe(reason);
                        expect(result.detail).toContain("lock kept");
                    } else {
                        expect(result.detail).toContain("lock restoration failed");
                        expect(result.detail).not.toContain("lock kept");
                        expect(lockReason()).toBe(mode === "foreign" ? "manual protection" : null);
                    }
                } finally {
                    spawn.mockRestore();
                    persist.mockRestore();
                }
            }
        } finally {
            unlinkSync(dirty);
        }
    });

    it("protects both live sessions until the last user ends, and refuses release while another user remains", () => {
        lockWorktreesForPaths({ sessionId: "shared-a", paths: [wt], agent: me });
        lockWorktreesForPaths({ sessionId: "shared-b", paths: [wt], agent: me });
        writeFileSync(join(wt, "keep-shared.txt"), "protect the fixture on a planted regression");

        try {
            const release = releaseSessionWorktree({ worktree: wt, sessionId: "shared-a" });
            expect(release.removed).toBe(false);
            expect(release.detail).toContain("live session");
            expect(unlockSessionWorktrees("shared-a")).toEqual([]);
            expect(parseLockReason(lockReason() ?? "")).toMatchObject({ sessionId: "shared-b", pid: me.pid });
            expect(unlockSessionWorktrees("shared-b")).toEqual([wt]);
            expect(lockReason()).toBeNull();
        } finally {
            unlinkSync(join(wt, "keep-shared.txt"));
        }
    });

    it("skips corrupt user and record files while preserving valid users and finishing other worktrees", () => {
        const session = "corrupt-record-owner";
        lockWorktreesForPaths({ sessionId: session, paths: [wt, otherWt], agent: me });
        lockWorktreesForPaths({ sessionId: "valid-survivor", paths: [wt], agent: me });
        const records = join(
            env.getTrimmed("GENESIS_TOOLS_HOME") ?? homedir(),
            ".genesis-tools",
            "claude-code",
            "worktree-locks",
            `${session}.json.d`
        );
        const users = join(admin, "session-users");

        for (const directory of [records, users]) {
            writeFileSync(join(directory, "corrupt.json"), "{");
            writeFileSync(join(directory, "invalid.json"), JSON.stringify({ harness: "unknown" }));
            mkdirSync(join(directory, "unreadable.json"));
        }

        const badDate = join(users, "000-invalid-date.json");
        writeFileSync(badDate, JSON.stringify({ sessionId: "bad-date", ...me, since: "invalid" }));
        const warnings = spyOn(fs, "appendFileSync");

        try {
            const release = releaseSessionWorktree({ worktree: wt, sessionId: session });
            expect(release.removed).toBe(false);
            expect(release.detail).toContain("live session");
            expect(unlockSessionWorktrees(session)).toEqual([otherWt]);
            expect(readLockReason(otherAdmin)).toBeNull();
            expect(parseLockReason(lockReason() ?? "")).toMatchObject({ sessionId: "valid-survivor" });
            expect(unlockSessionWorktrees("valid-survivor")).toEqual([wt]);
            expect(lockReason()).toBeNull();
            expect(warnings.mock.calls.some(([, data]) => String(data).includes(badDate))).toBe(true);

            for (const directory of [records, users]) {
                for (const name of ["corrupt.json", "invalid.json", "unreadable.json"]) {
                    expect(warnings.mock.calls.some(([, data]) => String(data).includes(join(directory, name)))).toBe(
                        true
                    );
                }
            }
        } finally {
            warnings.mockRestore();
        }
    });

    it("keeps both repositories when two record publications overlap", () => {
        const session = "two-repositories";
        const prefix = join(
            env.getTrimmed("GENESIS_TOOLS_HOME") ?? homedir(),
            ".genesis-tools",
            "claude-code",
            "worktree-locks",
            `${session}.json`
        );
        const publish = fs.renameSync;
        const pending: Array<{ target: string; bytes: Buffer }> = [];
        const rename = spyOn(fs, "renameSync").mockImplementation((source, target) => {
            if (typeof target === "string" && target.startsWith(prefix)) {
                pending.push({ target, bytes: fs.readFileSync(source) });
                return;
            }

            publish(source, target);
        });

        try {
            lockWorktreesForPaths({ sessionId: session, paths: [wt], agent: me });
            lockWorktreesForPaths({ sessionId: session, paths: [otherWt], agent: me });
        } finally {
            rename.mockRestore();
        }

        expect(pending).toHaveLength(2);

        for (const item of pending) {
            writeFileSync(item.target, item.bytes);
        }

        expect(unlockSessionWorktrees(session).sort()).toEqual([wt, otherWt].sort());
        expect(lockReason()).toBeNull();
        expect(readLockReason(otherAdmin)).toBeNull();
    });

    it("stops after one failed agent lookup without claiming any worktree is held", () => {
        let calls = 0;
        const attempt = lockWorktreesForPaths({
            sessionId: "no-agent",
            paths: [wt, otherWt],
            findAgent: () => {
                calls++;
                return null;
            },
        });
        expect(calls).toBe(1);
        expect(attempt.size).toBe(0);
        expect(lockReason()).toBeNull();
        expect(readLockReason(otherAdmin)).toBeNull();
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

    it("a failed process read keeps a live owner's lock; only a pid that no process holds is gone", () => {
        // The reader answers null on EACCES, a failed sysctl or a ps timeout too, so null alone frees nothing.
        const failedRead = () => null;
        const now = new Date().toISOString();

        expect(isLockStale(parseLockReason(`claude session x pid ${process.pid} since ${now}`), failedRead)).toBe(
            false
        );
        expect(isLockStale(parseLockReason(`claude session x (pid ${DEAD_PID})`), failedRead)).toBe(true);
    });

    it("a live pid that another program now holds is a recycled pid, so its lock is stale", () => {
        // This test process is bun, not claude, codex or grok.
        const now = new Date().toISOString();

        expect(isLockStale(parseLockReason(`claude session other pid ${process.pid} since ${now}`))).toBe(true);
        expect(
            isLockStale(parseLockReason(`claude agent a1b2c3 (pid ${process.pid} start Mon Oct 13 20:00:00 2026)`))
        ).toBe(true);
        expect(isLockStale(parseLockReason(`claude agent a1b2c3 (pid ${me.pid} start Mon Oct 13 20:00:00 2026)`))).toBe(
            false
        );
    });

    it("SessionEnd unlocks only this session's locks and drops its record", () => {
        lockWorktreesForPaths({ sessionId: "s-end", paths: [wt], agent: me });
        const record = join(
            env.getTrimmed("GENESIS_TOOLS_HOME") ?? homedir(),
            ".genesis-tools",
            "claude-code",
            "worktree-locks",
            "s-end.json.d"
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
