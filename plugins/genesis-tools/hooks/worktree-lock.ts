#!/usr/bin/env bun
/**
 * A running agent session locks every linked git worktree it works in, so `git worktree remove`
 * from another session refuses it (git needs `-f -f` for a locked worktree). The session unlocks
 * its worktrees when the last registered live user ends, handing the lock to a survivor otherwise.
 * Asked for on 2026-10-13, after cleanup sessions removed worktrees that
 * another running session was still working in.
 *
 * When it locks:
 * - SessionStart, when the session's folder is inside a linked worktree. It first clears the stale
 *   session locks of that repository.
 * - PostToolUse of an edit tool, for the edited file's worktree.
 * - PostToolUse of a shell call, for every absolute path the command text names, and the folder the
 *   call ran in. The PostToolUse part runs inside `area-rules.ts`, which already starts on every Bash
 *   and edit call, so a tool call costs no second `bun` start. A command that names no path inside a
 *   linked worktree spawns nothing at all.
 *
 * A main checkout is never locked. Telling the two apart costs no git: the first `.git` above a path
 * is a FILE in a linked worktree and a folder in a main checkout. The lock state is read from git's
 * own `<admin>/locked` file; only taking or releasing a lock runs git.
 *
 * The reason names the owner: `<harness> session <session id> pid <agent pid> since <ISO time>`. The
 * pid is the claude, codex or grok process, found by walking up from the hook (a hook runs under a
 * shell). A lock whose pid is dead, or alive but started after the lock was taken (pid reuse), is
 * stale. A lock in any other shape is a hand lock and is never touched.
 *
 * 🛑 Claude Code 2.1.296 locks the worktrees it creates or enters itself (`--worktree`, EnterWorktree,
 * agent isolation) as `claude session|agent <name> (pid N start S)`, and takes such a lock over once
 * its pid is dead. Our reason is deliberately NOT in that shape, so Claude Code treats ours as a hand
 * lock and never clears it. We read its shape only to leave a live one alone and to count a dead one
 * stale, by the rule Claude Code itself applies.
 *
 * Silent and never fatal: no stdout, exit 0 always, problems go to the GenesisTools day log.
 */
import { dlopen, FFIType } from "bun:ffi";
import { createHash } from "node:crypto";
import {
    appendFileSync,
    closeSync,
    existsSync,
    fstatSync,
    lstatSync,
    mkdirSync,
    openSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmdirSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { readProcessBasics } from "../lib/process-basics";
import { EDIT_TOOLS, filePathsOf, type HookInput, normalize, writeFailed } from "./edit-payload";
import type { Harness } from "./harness";

const SafeJSON = JSON;

const HARNESSES: readonly Harness[] = ["claude", "codex", "grok"];
/** A real tree is never this deep; a symlink loop would be. */
const MAX_DEPTH = 64;
const MAX_ANCESTORS = 12;
const MAX_COMMAND_CHARS = 20_000;
const MAX_COMMAND_PATHS = 32;
const SPAWN_TIMEOUT_MS = 3000;
/**
 * `git worktree remove` deletes the whole folder, `node_modules` included (about 100,000 files in this repo), so
 * the hook's 3 s limit killed it halfway through on 2026-10-14 and left a half-deleted worktree.
 */
const REMOVE_TIMEOUT_MS = 300_000;
/** `ps -o etime` counts whole seconds. */
const START_SLACK_MS = 2000;
/** The session id becomes a file name and part of the lock reason. */
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const SESSION_REASON = /^(claude|codex|grok) session (\S{1,120}) pid (\d{1,10}) since (\S{1,40})$/;
/** Claude Code's own lock reason, copied from its 2.1.296 binary. */
const CLAUDE_NATIVE_REASON = /^claude (?:agent|session) .{1,255} \(pid (\d{1,10})(?: start (.{1,255}))?\)$/;
/** The variables that would point a git child at another repository than the one we name. */
const GIT_ENV = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_PREFIX"];

export interface LinkedWorktree {
    /** The worktree's top folder. */
    root: string;
    /** `<commonDir>/worktrees/<name>`: git's folder for this worktree, which holds the `locked` file. */
    adminDir: string;
    /** The repository's shared git folder. */
    commonDir: string;
}

/** The agent process a lock names. */
export interface AgentProcess {
    harness: Harness;
    pid: number;
}

export type LockHolder =
    | { kind: "session"; harness: Harness; sessionId: string; pid: number; since: string }
    | { kind: "claude-native"; pid: number }
    | { kind: "other"; reason: string };

export type LockOutcome = "locked" | "ours" | "held";

export interface StaleLock extends LinkedWorktree {
    reason: string;
}

interface RecordedLock extends LinkedWorktree {
    pid: number;
    at: string;
}

/** What SessionEnd unlocks, so it never scans every repository on the machine. */
interface LockRecord {
    session_id: string;
    harness: Harness;
    pid: number;
    locks: RecordedLock[];
}

function genesisHome(): string {
    // Standalone hook script: no @genesiscz/utils/env, so process.env directly, like the sibling hooks.
    return process.env.GENESIS_TOOLS_HOME || homedir();
}

function errorCode(error: unknown): unknown {
    return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function harnessNamed(value: unknown): Harness | null {
    return HARNESSES.find((harness) => harness === value) ?? null;
}

const LOG_LEVELS = { info: 30, warn: 40, error: 50 } as const;

/**
 * One pino-shaped line in `~/.genesis-tools/logs/<local date>.log`, the day log every tool writes. A
 * hook cannot import the logger, and its stdout is read by the harness, so this is its only voice.
 */
function dayLog(level: keyof typeof LOG_LEVELS, msg: string, fields: Record<string, unknown> = {}): void {
    try {
        const now = new Date();
        const pad = (value: number) => String(value).padStart(2, "0");
        const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
        const dir = join(genesisHome(), ".genesis-tools", "logs");
        const line = {
            level: LOG_LEVELS[level],
            time: now.toISOString(),
            pid: process.pid,
            hostname: hostname(),
            component: "worktree-lock",
            ...fields,
            msg: `[worktree-lock] ${msg}`,
        };

        mkdirSync(dir, { recursive: true });
        appendFileSync(join(dir, `${day}.log`), `${SafeJSON.stringify(line)}\n`);
    } catch (error) {
        // The day log itself failed. Stderr is the last place left, and a hook's stderr reaches only
        // the harness's debug view, so it never disturbs the session.
        process.stderr.write(`[worktree-lock] ${msg}; the day log failed too: ${String(error)}\n`);
    }
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** What the first `.git` at or above `dir` is, or null when there is none at this level. */
function dotGitAt(dir: string): "folder" | "file" | null {
    try {
        const stat = lstatSync(join(dir, ".git"));

        return stat.isFile() ? "file" : "folder";
    } catch (error) {
        const code = errorCode(error);

        if (code !== "ENOENT" && code !== "ENOTDIR") {
            dayLog("warn", "cannot read a .git entry; treating the folder as no repository", {
                dir,
                error: messageOf(error),
            });
        }

        return null;
    }
}

/** The `gitdir:` target of a `.git` file, made absolute against the folder that holds the file. */
function gitdirOf(dir: string): string | null {
    const target = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(join(dir, ".git"), "utf8"))?.[1];

    return target ? resolve(dir, target) : null;
}

/**
 * The linked worktree that holds `path`, with fs calls only. The first `.git` above the path decides:
 * a folder is a main checkout, a file whose gitdir has a `commondir` is a linked worktree. A
 * submodule's `.git` file points into `modules/`, which has no `commondir`, so it is not one.
 */
export function linkedWorktreeOf(
    path: string,
    cache = new Map<string, LinkedWorktree | null>()
): LinkedWorktree | null {
    const visited: string[] = [];
    let dir = resolve(path);
    let found: LinkedWorktree | null = null;

    for (let depth = 0; depth < MAX_DEPTH; depth++) {
        const known = cache.get(dir);

        if (known !== undefined) {
            found = known;
            break;
        }

        visited.push(dir);
        const kind = dotGitAt(dir);

        if (kind === "folder") {
            break;
        }

        if (kind === "file") {
            found = linkedWorktreeAt(dir);
            break;
        }

        const parent = dirname(dir);

        if (parent === dir) {
            break;
        }

        dir = parent;
    }

    for (const each of visited) {
        cache.set(each, found);
    }

    return found;
}

function linkedWorktreeAt(root: string): LinkedWorktree | null {
    try {
        const adminDir = gitdirOf(root);

        if (!adminDir) {
            return null;
        }

        const common = readFileSync(join(adminDir, "commondir"), "utf8").trim();

        return { root, adminDir, commonDir: resolve(adminDir, common) };
    } catch (error) {
        // ENOENT on `commondir`: a submodule, or a worktree whose admin folder was pruned.
        if (errorCode(error) !== "ENOENT") {
            dayLog("warn", "cannot read a linked worktree's git files", { root, error: messageOf(error) });
        }

        return null;
    }
}

/** The shared git folder of the repository that holds `path`, from a main checkout or a linked worktree. */
export function commonDirOf(path: string): string | null {
    let dir = resolve(path);

    for (let depth = 0; depth < MAX_DEPTH; depth++) {
        const kind = dotGitAt(dir);

        if (kind === "folder") {
            return join(dir, ".git");
        }

        if (kind === "file") {
            return linkedWorktreeAt(dir)?.commonDir ?? null;
        }

        const parent = dirname(dir);

        if (parent === dir) {
            return null;
        }

        dir = parent;
    }

    return null;
}

/** The reason in git's `locked` file: `""` for a lock without one, null when the worktree is not locked. */
export function readLockReason(adminDir: string): string | null {
    try {
        return readFileSync(join(adminDir, "locked"), "utf8").trim();
    } catch (error) {
        if (errorCode(error) === "ENOENT") {
            return null;
        }

        throw error;
    }
}

export function formatLockReason(options: { agent: AgentProcess; sessionId: string; since: Date }): string {
    const { agent, sessionId, since } = options;

    return `${agent.harness} session ${sessionId} pid ${agent.pid} since ${since.toISOString()}`;
}

export function parseLockReason(reason: string): LockHolder {
    const text = reason.trim();
    const session = SESSION_REASON.exec(text);
    const harness = harnessNamed(session?.[1]);

    if (session && harness) {
        return {
            kind: "session",
            harness,
            sessionId: session[2] ?? "",
            pid: Number(session[3]),
            since: session[4] ?? "",
        };
    }

    const native = CLAUDE_NATIVE_REASON.exec(text);

    if (native) {
        return { kind: "claude-native", pid: Number(native[1]) };
    }

    return { kind: "other", reason: text };
}

type ProcessCheck = { state: "gone" } | { state: "unknown" } | { state: "live"; agent: boolean; startMs: number };

/**
 * What `pid` is now, from the kernel (`readProcessBasics`, no spawn): "gone" when no process has it,
 * "unknown" when its command line or start time cannot be read (another user's process, a zombie),
 * else whether the process is claude, codex or grok and when it started. A bare kill(pid, 0) cannot
 * tell the lock's agent from a recycled pid that another program now holds.
 */
function checkProcess(pid: number): ProcessCheck {
    // pid 0 and below are process groups, and pid 1 is launchd: none names a session.
    if (!Number.isInteger(pid) || pid <= 1) {
        return { state: "gone" };
    }

    const basics = readProcessBasics(pid);

    if (!basics) {
        return { state: "gone" };
    }

    if (basics.command === null || basics.startMs === null) {
        return { state: "unknown" };
    }

    return { state: "live", agent: agentNamed(basics.command) !== null, startMs: basics.startMs };
}

/** Read each distinct owner once through the kernel; share those results across the ownership scan. */
function checkProcesses(pids: number[]): Map<number, ProcessCheck> {
    return new Map([...new Set(pids)].map((pid) => [pid, checkProcess(pid)]));
}

/** Whether `pid` is still a running agent. When the kernel cannot answer, it counts as alive: a wrong "dead" frees a worktree in use. */
function agentAlive(pid: number): boolean {
    const check = checkProcess(pid);

    return check.state === "unknown" || (check.state === "live" && check.agent);
}

/**
 * Whether a lock's owner is gone. A hand lock never is. A session lock is stale when its pid is dead,
 * when another program now holds the pid, or when the pid started after the lock was taken (a reused
 * pid). Claude Code's own lock carries no time we can compare, so only its pid and program count. When
 * the kernel cannot answer, the lock is kept: a wrong "stale" lets a worktree in use be removed.
 */
export function isLockStale(holder: LockHolder): boolean {
    return staleFromCheck(holder, holder.kind === "other" ? { state: "unknown" } : checkProcess(holder.pid));
}

function staleFromCheck(holder: LockHolder, check: ProcessCheck): boolean {
    if (holder.kind === "other") {
        return false;
    }

    if (check.state !== "live") {
        return check.state === "gone";
    }

    if (!check.agent) {
        return true;
    }

    const since = holder.kind === "session" ? Date.parse(holder.since) : Number.NaN;

    return !Number.isNaN(since) && check.startMs > since + START_SLACK_MS;
}

function gitEnv(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...process.env };

    for (const key of GIT_ENV) {
        delete env[key];
    }

    return env;
}

function git(commonDir: string, args: string[], timeoutMs = SPAWN_TIMEOUT_MS): { ok: boolean; stderr: string } {
    const result = Bun.spawnSync(["git", `--git-dir=${commonDir}`, ...args], {
        stdout: "ignore",
        stderr: "pipe",
        env: gitEnv(),
        timeout: timeoutMs,
    });
    const stderr = result.stderr.toString().trim();

    if (result.exitCode === null) {
        return {
            ok: false,
            stderr: `git ${args[0]} was stopped after ${timeoutMs} ms (${result.signalCode ?? "no signal"})`,
        };
    }

    return { ok: result.exitCode === 0, stderr };
}

type WorktreeFlock = (fd: number, operation: number) => number;
let worktreeFlock: WorktreeFlock | null | undefined;
const GUARD_WAIT_MS = 1000;
const GUARD_RETRY_MS = 10;
const guardWaitWord = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

/** Kernel ownership dies with the hook; the guard file stays so contenders always lock the same inode. */
function withWorktreeLock<T>(worktree: LinkedWorktree, action: () => T): T | undefined {
    if (worktreeFlock === undefined) {
        worktreeFlock = null;
        const library =
            process.platform === "darwin" ? "libSystem.B.dylib" : process.platform === "linux" ? "libc.so.6" : null;

        if (library) {
            try {
                const { symbols } = dlopen(library, {
                    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
                });
                worktreeFlock = (fd, operation) => symbols.flock(fd, operation);
            } catch (error) {
                dayLog("error", "cannot load worktree guard; locks will be left alone", { error: messageOf(error) });
            }
        }
    }

    if (!worktreeFlock) {
        return undefined;
    }

    const path = join(worktree.adminDir, "session-lock.flock");
    let fd: number;

    try {
        fd = openSync(path, "a", 0o600);
    } catch (error) {
        dayLog("warn", "cannot open worktree guard", { worktree: worktree.root, error: messageOf(error) });
        return undefined;
    }

    try {
        // LOCK_EX | LOCK_NB: let a short ownership transition finish before skipping a new user's registration.
        const deadline = performance.now() + GUARD_WAIT_MS;
        while (worktreeFlock(fd, 2 | 4) !== 0) {
            const remaining = deadline - performance.now();
            if (remaining <= 0) {
                return undefined;
            }

            // This hook is synchronous. Sleep in the kernel, without spinning or starting another process.
            Atomics.wait(guardWaitWord, 0, 0, Math.min(GUARD_RETRY_MS, remaining));
        }

        const held = fstatSync(fd);
        const named = statSync(path);

        if (held.dev !== named.dev || held.ino !== named.ino) {
            return undefined;
        }

        return action();
    } finally {
        closeSync(fd);
    }
}

/**
 * Unlock a worktree whose lock still reads `expectedReason`. git finds the worktree by its folder,
 * so a folder moved with plain `mv` makes `git worktree unlock` fail. Then the `locked` file is
 * removed directly, which is all git itself does. Every caller holds withWorktreeLock across its
 * ownership check and this unlock, plus any replacement lock or worktree removal.
 */
function unlockWorktree(worktree: LinkedWorktree, expectedReason: string): boolean {
    if (readLockReason(worktree.adminDir) !== expectedReason) {
        return false;
    }

    const result = git(worktree.commonDir, ["worktree", "unlock", worktree.root]);

    if (result.ok) {
        return true;
    }

    if (readLockReason(worktree.adminDir) !== expectedReason) {
        return false;
    }

    try {
        unlinkSync(join(worktree.adminDir, "locked"));
        dayLog("warn", "git worktree unlock failed; removed the lock file directly", {
            worktree: worktree.root,
            stderr: result.stderr,
        });

        return true;
    } catch (error) {
        dayLog("error", "cannot unlock a worktree", { worktree: worktree.root, error: messageOf(error) });

        return false;
    }
}

/** Restore our reason under the guard, using exclusive creation so a competing lock is never overwritten. */
function restoreWorktreeLock(worktree: LinkedWorktree, reason: string): boolean {
    const result = git(worktree.commonDir, ["worktree", "lock", "--reason", reason, worktree.root]);
    try {
        if (readLockReason(worktree.adminDir) === null) {
            writeFileSync(join(worktree.adminDir, "locked"), `${reason}\n`, { flag: "wx", mode: 0o600 });
        }

        if (readLockReason(worktree.adminDir) === reason) {
            if (!result.ok) {
                dayLog("warn", "git lock restoration failed; protection recovered through the lock file", {
                    worktree: worktree.root,
                    stderr: result.stderr,
                });
            }
            return true;
        }
    } catch (error) {
        dayLog("error", "cannot restore a worktree lock", { worktree: worktree.root, error: messageOf(error) });
    }

    dayLog("error", "worktree lock restoration failed; expected protection was not restored", {
        worktree: worktree.root,
        stderr: result.stderr,
    });
    return false;
}

/** Every worktree git has registered in `commonDir`, with its lock reason. Reads files only. */
function registeredWorktrees(commonDir: string): Array<LinkedWorktree & { reason: string | null }> {
    const parent = join(commonDir, "worktrees");
    let names: string[];

    try {
        names = readdirSync(parent);
    } catch (error) {
        if (errorCode(error) === "ENOENT") {
            return [];
        }

        throw error;
    }

    const found: Array<LinkedWorktree & { reason: string | null }> = [];

    for (const name of names) {
        const adminDir = join(parent, name);

        try {
            // `gitdir` holds `<root>/.git`, absolute, or relative to the admin folder.
            const gitdir = readFileSync(join(adminDir, "gitdir"), "utf8").trim();
            found.push({
                root: dirname(resolve(adminDir, gitdir)),
                adminDir,
                commonDir,
                reason: readLockReason(adminDir),
            });
        } catch (error) {
            if (errorCode(error) !== "ENOENT" && errorCode(error) !== "ENOTDIR") {
                dayLog("warn", "cannot read a registered worktree", { adminDir, error: messageOf(error) });
            }
        }
    }

    return found;
}

/**
 * The check cleanup tools call before they force anything: the session locks in the repository that
 * holds `repoPath` (a main checkout or any of its worktrees) whose owner is gone. It reads files and
 * reads the kernel; it never changes a lock. `clearStaleWorktreeLocks` is the step that acts on it.
 */
export function findStaleWorktreeLocks(repoPath: string): StaleLock[] {
    const { locks, checks } = scanStaleWorktreeLocks(repoPath);
    return locks.filter((lock) => liveUsers(lock, checks).length === 0);
}

function scanStaleWorktreeLocks(repoPath: string): { locks: StaleLock[]; checks: Map<number, ProcessCheck> } {
    const commonDir = commonDirOf(repoPath);
    const worktrees = commonDir ? registeredWorktrees(commonDir) : [];
    const holders = worktrees.map((worktree) => (worktree.reason === null ? null : parseLockReason(worktree.reason)));
    const pids = holders.flatMap((holder) => (holder && holder.kind !== "other" ? [holder.pid] : []));

    for (const worktree of worktrees) {
        pids.push(...readUsers(worktree).map((user) => user.pid));
    }

    const checks = checkProcesses(pids);
    const locks = worktrees.flatMap((worktree, index) => {
        const holder = holders[index];
        return worktree.reason !== null &&
            holder &&
            holder.kind !== "other" &&
            staleFromCheck(holder, checks.get(holder.pid) ?? { state: "unknown" })
            ? [{ ...worktree, reason: worktree.reason }]
            : [];
    });
    return { locks, checks };
}

/** Recheck the reason under the guard, retaining any surviving registered user from the same process snapshot. */
export function clearStaleWorktreeLocks(repoPath: string): StaleLock[] {
    const { locks, checks } = scanStaleWorktreeLocks(repoPath);
    const cleared: StaleLock[] = [];

    for (const lock of locks) {
        if (
            withWorktreeLock(
                lock,
                () =>
                    readLockReason(lock.adminDir) === lock.reason &&
                    handoffOrUnlock({ worktree: lock, reason: lock.reason, checks }) === "unlocked"
            )
        ) {
            cleared.push(lock);
            dayLog("info", "cleared a stale worktree lock", { worktree: lock.root, reason: lock.reason });
        }
    }

    return cleared;
}

function recordPath(sessionId: string): string {
    return join(genesisHome(), ".genesis-tools", "claude-code", "worktree-locks", `${sessionId}.json`);
}

function recordFiles(sessionId: string): string[] {
    const legacy = recordPath(sessionId);
    let shards: string[] = [];

    try {
        shards = readdirSync(`${legacy}.d`)
            .filter((name) => name.endsWith(".json"))
            .map((name) => join(`${legacy}.d`, name));
    } catch (error) {
        if (errorCode(error) !== "ENOENT") {
            dayLog("warn", "cannot list worktree-lock records", { path: `${legacy}.d`, error: messageOf(error) });
        }
    }

    return existsSync(legacy) ? [legacy, ...shards] : shards;
}

function readRecord(sessionId: string): LockRecord | null {
    const merged = new Map<string, RecordedLock>();
    let latest: LockRecord | null = null;
    let latestAt = "";

    for (const path of recordFiles(sessionId)) {
        try {
            const parsed: unknown = SafeJSON.parse(readFileSync(path, "utf8"));
            const harness = isRecord(parsed) ? harnessNamed(parsed.harness) : null;

            if (!isRecord(parsed) || !harness || typeof parsed.pid !== "number" || !Array.isArray(parsed.locks)) {
                throw new Error("invalid worktree-lock record");
            }

            const locks = parsed.locks.filter(
                (lock): lock is RecordedLock =>
                    isRecord(lock) &&
                    typeof lock.root === "string" &&
                    typeof lock.adminDir === "string" &&
                    typeof lock.commonDir === "string" &&
                    typeof lock.pid === "number" &&
                    typeof lock.at === "string"
            );

            if (locks.length !== parsed.locks.length) {
                dayLog("warn", "invalid worktree-lock record entry; skipping entry", { path });
            }

            for (const lock of locks) {
                const previous = merged.get(lock.adminDir);

                if (!previous || previous.at <= lock.at) {
                    merged.set(lock.adminDir, lock);
                }

                if (lock.at >= latestAt) {
                    latestAt = lock.at;
                    latest = { session_id: sessionId, harness, pid: lock.pid, locks: [] };
                }
            }
        } catch (error) {
            dayLog("warn", "cannot read worktree-lock record; skipping file", { path, error: messageOf(error) });
        }
    }

    return latest ? { ...latest, locks: [...merged.values()] } : null;
}

function recordShard(sessionId: string, adminDir: string): string {
    return join(`${recordPath(sessionId)}.d`, `${createHash("sha256").update(adminDir).digest("hex")}.json`);
}

/** Each guarded worktree publishes its own shard; writers in other repositories never overwrite it. */
function writeRecord(record: LockRecord): void {
    for (const lock of record.locks) {
        const path = recordShard(record.session_id, lock.adminDir);
        mkdirSync(dirname(path), { recursive: true });
        const temp = `${path}.tmp.${process.pid}`;
        writeFileSync(temp, SafeJSON.stringify({ ...record, locks: [lock] }, null, 2));
        renameSync(temp, path);
    }
}

interface SessionUser {
    sessionId: string;
    harness: Harness;
    pid: number;
    since: string;
}

function userPath(worktree: LinkedWorktree, sessionId: string): string {
    return join(worktree.adminDir, "session-users", `${sessionId}.json`);
}

function readUser(path: string): SessionUser | null {
    try {
        const value: unknown = SafeJSON.parse(readFileSync(path, "utf8"));
        const harness = isRecord(value) ? harnessNamed(value.harness) : null;

        if (
            !isRecord(value) ||
            typeof value.sessionId !== "string" ||
            !SAFE_SESSION_ID.test(value.sessionId) ||
            !harness ||
            typeof value.pid !== "number" ||
            typeof value.since !== "string" ||
            !Number.isFinite(Date.parse(value.since))
        ) {
            throw new Error("invalid worktree user");
        }

        return { sessionId: value.sessionId, harness, pid: value.pid, since: value.since };
    } catch (error) {
        if (errorCode(error) !== "ENOENT") {
            dayLog("warn", "cannot read worktree user; skipping file", { path, error: messageOf(error) });
        }

        return null;
    }
}

function readUsers(worktree: LinkedWorktree): SessionUser[] {
    const directory = join(worktree.adminDir, "session-users");
    let names: string[];

    try {
        names = readdirSync(directory).filter((name) => name.endsWith(".json"));
    } catch (error) {
        if (errorCode(error) !== "ENOENT") {
            dayLog("warn", "cannot list worktree users; skipping directory", {
                path: directory,
                error: messageOf(error),
            });
        }

        return [];
    }

    return names.flatMap((name) => {
        const user = readUser(join(directory, name));
        return user ? [user] : [];
    });
}

function liveUsers(worktree: LinkedWorktree, snapshot?: Map<number, ProcessCheck>): SessionUser[] {
    const users = readUsers(worktree);
    const checks = snapshot ?? checkProcesses(users.map((user) => user.pid));
    return users.filter(
        (user) => !staleFromCheck({ kind: "session", ...user }, checks.get(user.pid) ?? { state: "unknown" })
    );
}

/** Called under the worktree guard, including when another live session owns git's primary lock. */
function rememberUser(worktree: LinkedWorktree, user: SessionUser): void {
    const path = userPath(worktree, user.sessionId);
    const previous = readUser(path);

    if (
        previous?.sessionId === user.sessionId &&
        previous.pid === user.pid &&
        previous.harness === user.harness &&
        existsSync(recordShard(user.sessionId, worktree.adminDir))
    ) {
        return;
    }

    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.tmp.${process.pid}`;
    writeFileSync(temp, SafeJSON.stringify(user));
    renameSync(temp, path);
    writeRecord({
        session_id: user.sessionId,
        harness: user.harness,
        pid: user.pid,
        locks: [{ ...worktree, pid: user.pid, at: user.since }],
    });
}

/** Change only git's reason, never dropping the lock while a surviving session is using the worktree. */
function handoffOrUnlock({
    worktree,
    reason,
    checks,
}: {
    worktree: LinkedWorktree;
    reason: string;
    checks?: Map<number, ProcessCheck>;
}): "unlocked" | "handed-off" | "failed" {
    const successor = liveUsers(worktree, checks)[0];

    if (!successor) {
        return unlockWorktree(worktree, reason) ? "unlocked" : "failed";
    }

    const path = join(worktree.adminDir, "locked");
    const temp = `${path}.tmp.${process.pid}`;
    writeFileSync(
        temp,
        `${formatLockReason({ agent: successor, sessionId: successor.sessionId, since: new Date(successor.since) })}\n`
    );
    renameSync(temp, path);
    return "handed-off";
}

function removeIfPresent(path: string): void {
    try {
        unlinkSync(path);
    } catch (error) {
        if (errorCode(error) !== "ENOENT") {
            throw error;
        }
    }
}

function agentNamed(command: string): Harness | null {
    const [program = "", script = ""] = command.trim().split(/\s+/, 2);

    for (const arg of [program, script]) {
        const harness = harnessNamed(/^(claude|codex|grok)(?:$|[-.])/.exec(basename(arg))?.[1]);

        if (harness) {
            return harness;
        }
    }

    // An npm install of Claude Code runs as `node …/@anthropic-ai/claude-code/cli.js`.
    return command.includes("/@anthropic-ai/claude-code/") ? "claude" : null;
}

/**
 * The agent process this hook belongs to: the nearest ancestor whose program is claude, codex or grok.
 * A hook runs under a shell, so its parent is rarely the agent itself. One kernel read per level, no
 * spawn. The nearest one is right also for a Codex worker started from a
 * Claude session, whose chain holds both.
 */
export function findAgentProcess(startPid = process.ppid): AgentProcess | null {
    let pid = startPid;

    for (let depth = 0; depth < MAX_ANCESTORS && pid > 1; depth++) {
        const basics = readProcessBasics(pid);

        if (!basics || basics.command === null) {
            return null;
        }

        const harness = agentNamed(basics.command);

        if (harness) {
            return { harness, pid };
        }

        pid = basics.ppid;
    }

    return null;
}

/**
 * Lock every linked worktree that holds one of `paths` for this session. Only fs calls until a
 * worktree turns up that no live owner holds; then one ancestor walk (cached in the session record)
 * and one `git worktree lock` per worktree.
 *
 * `agent` replaces the ancestor walk, for tests and callers that already know the owner. `fresh`
 * makes this session's own lock prove its process is alive (one `ps`), for SessionStart: a resumed
 * session runs under a new pid and takes its old lock over.
 */
export function lockWorktreesForPaths(options: {
    sessionId: string;
    paths: string[];
    agent?: AgentProcess;
    findAgent?: () => AgentProcess | null;
    now?: number;
    fresh?: boolean;
}): Map<string, LockOutcome> {
    const { sessionId, paths, now = Date.now(), fresh = false } = options;
    const outcomes = new Map<string, LockOutcome>();

    if (!SAFE_SESSION_ID.test(sessionId)) {
        return outcomes;
    }

    const cache = new Map<string, LinkedWorktree | null>();
    const worktrees = new Map<string, LinkedWorktree>();

    for (const path of paths) {
        const worktree = linkedWorktreeOf(path, cache);

        if (worktree) {
            worktrees.set(worktree.adminDir, worktree);
        }
    }

    let record: LockRecord | null | undefined;
    let agent = options.agent ?? null;
    let missingAgent = false;

    for (const worktree of worktrees.values()) {
        const outcome = withWorktreeLock(worktree, (): LockOutcome | undefined => {
            const current = readLockReason(worktree.adminDir);
            const holder = current === null ? null : parseLockReason(current);

            if (holder?.kind === "session" && holder.sessionId === sessionId) {
                // This session's lock under the pid it recorded: a hook only runs in a live session, so a
                // repeat call trusts that and spawns nothing.
                if (!agent && record === undefined) {
                    record = readRecord(sessionId);
                }

                const owner = agent?.pid ?? record?.pid;

                if (holder.pid === owner && (!fresh || agentAlive(holder.pid))) {
                    const ours = agent ?? (record ? { harness: record.harness, pid: record.pid } : null);

                    if (ours) {
                        rememberUser(worktree, { ...ours, sessionId, since: holder.since });
                    }
                    return "ours";
                }
            }

            if (holder?.kind === "other") {
                return "held";
            }

            if (!agent) {
                record ??= readRecord(sessionId);
                agent =
                    record && agentAlive(record.pid)
                        ? { harness: record.harness, pid: record.pid }
                        : (options.findAgent ?? findAgentProcess)();
            }

            if (!agent) {
                dayLog("warn", "no claude, codex or grok process above this hook; the worktree stays unlocked", {
                    session: sessionId,
                    worktree: worktree.root,
                });
                missingAgent = true;
                return undefined;
            }

            const user = { ...agent, sessionId, since: new Date(now).toISOString() };

            if (holder && !isLockStale(holder)) {
                rememberUser(worktree, user);
                return "held";
            }

            if (current !== null && handoffOrUnlock({ worktree, reason: current }) !== "unlocked") {
                rememberUser(worktree, user);
                return "held";
            }

            if (current !== null && readLockReason(worktree.adminDir) !== null) {
                return "held";
            }

            if (current !== null) {
                dayLog("info", "took over a stale worktree lock", { worktree: worktree.root, previous: current });
            }

            const since = new Date(now);
            const reason = formatLockReason({ agent, sessionId, since });
            const result = git(worktree.commonDir, ["worktree", "lock", "--reason", reason, worktree.root]);

            if (!result.ok) {
                // Usually a lost race: another session locked it between our read and git's own check.
                dayLog("warn", "git worktree lock failed", { worktree: worktree.root, stderr: result.stderr });
                return "held";
            }

            dayLog("info", "locked a worktree for this session", { worktree: worktree.root, reason });
            rememberUser(worktree, { ...user, since: since.toISOString() });
            return "locked";
        });
        if (missingAgent) {
            break;
        }

        outcomes.set(worktree.root, outcome ?? "held");
    }

    return outcomes;
}

/**
 * SessionEnd: drop this user's registration, handing its primary lock to a surviving live user or
 * unlocking when nobody remains. A lock that another live process of the same session holds
 * (two processes resumed one session) stays.
 */
export function unlockSessionWorktrees(sessionId: string): string[] {
    if (!SAFE_SESSION_ID.test(sessionId)) {
        return [];
    }

    const record = readRecord(sessionId);

    if (!record) {
        return [];
    }

    const candidates = new Map<string, LinkedWorktree>(record.locks.map((lock) => [lock.adminDir, lock]));

    for (const commonDir of new Set(record.locks.map((lock) => lock.commonDir))) {
        for (const { reason, ...worktree } of registeredWorktrees(commonDir)) {
            const holder = reason === null ? null : parseLockReason(reason);

            if (holder?.kind === "session" && holder.sessionId === sessionId) {
                candidates.set(worktree.adminDir, worktree);
            }
        }
    }

    const unlocked: string[] = [];
    let busy = false;

    for (const worktree of candidates.values()) {
        if (!existsSync(worktree.adminDir)) {
            continue;
        }

        let released: boolean | undefined;
        try {
            released = withWorktreeLock(worktree, () => {
                const reason = readLockReason(worktree.adminDir);
                const holder = reason === null ? null : parseLockReason(reason);

                if (
                    holder?.kind === "session" &&
                    holder.sessionId === sessionId &&
                    holder.pid !== record.pid &&
                    agentAlive(holder.pid)
                ) {
                    return undefined;
                }

                removeIfPresent(userPath(worktree, sessionId));
                if (reason !== null && holder?.kind === "session" && holder.sessionId === sessionId) {
                    const transition = handoffOrUnlock({ worktree, reason });
                    if (transition === "failed") {
                        return undefined;
                    }

                    removeIfPresent(recordShard(sessionId, worktree.adminDir));
                    return transition === "unlocked";
                }

                removeIfPresent(recordShard(sessionId, worktree.adminDir));
                return false;
            });
        } catch (error) {
            dayLog("warn", "session ownership transition failed; keeping its record for retry", {
                session: sessionId,
                worktree: worktree.root,
                error: messageOf(error),
            });
            busy = true;
            continue;
        }

        if (released) {
            unlocked.push(worktree.root);
        } else if (released === undefined) {
            busy = true;
        }
    }

    if (unlocked.length > 0) {
        dayLog("info", "session ended; unlocked its worktrees", { session: sessionId, worktrees: unlocked });
    }

    if (busy) {
        return unlocked;
    }

    removeIfPresent(recordPath(sessionId));

    try {
        rmdirSync(`${recordPath(sessionId)}.d`);
    } catch (error) {
        if (errorCode(error) !== "ENOENT" && errorCode(error) !== "ENOTEMPTY") {
            dayLog("warn", "cannot remove worktree-lock record directory", {
                session: sessionId,
                error: messageOf(error),
            });
        }
    }

    return unlocked;
}

/**
 * Remove a linked worktree before this session ends, when the only lock on it is this session's own.
 * An orchestrator that names its workers' worktrees in commands holds their locks until SessionEnd,
 * and the PostToolUse hook locks again any worktree a command names, so a separate unlock would be
 * undone by the very command that ran it. So this unlocks and runs `git worktree remove` (never
 * forced) in one process, and puts the same lock back when git refuses (uncommitted or untracked
 * files). A lock that names another session, or is not a session lock at all, is never touched.
 */
export function releaseSessionWorktree(options: { worktree: string; sessionId: string }): {
    removed: boolean;
    detail: string;
} {
    if (!SAFE_SESSION_ID.test(options.sessionId)) {
        return { removed: false, detail: `not a session id: ${options.sessionId}` };
    }

    const worktree = linkedWorktreeOf(options.worktree);

    if (!worktree || worktree.root !== resolve(options.worktree)) {
        return { removed: false, detail: `${options.worktree} is not the root of a linked worktree` };
    }

    return (
        withWorktreeLock(worktree, () => {
            const reason = readLockReason(worktree.adminDir);
            const holder = reason === null ? null : parseLockReason(reason);

            if (reason !== null && !(holder?.kind === "session" && holder.sessionId === options.sessionId)) {
                return { removed: false, detail: `locked by someone else: ${reason}` };
            }

            const others = liveUsers(worktree).filter((user) => user.sessionId !== options.sessionId);

            if (others.length > 0) {
                return {
                    removed: false,
                    detail: `worktree is used by another live session: ${others.map((user) => user.sessionId).join(", ")}`,
                };
            }

            if (reason !== null && !unlockWorktree(worktree, reason)) {
                return { removed: false, detail: `cannot unlock: ${reason}` };
            }

            const removal = git(worktree.commonDir, ["worktree", "remove", worktree.root], REMOVE_TIMEOUT_MS);

            if (!removal.ok) {
                if (reason === null) {
                    return { removed: false, detail: `git refused; worktree was not locked: ${removal.stderr}` };
                }

                const restored = restoreWorktreeLock(worktree, reason);
                return {
                    removed: false,
                    detail: restored
                        ? `git refused, lock kept: ${removal.stderr}`
                        : `git refused; lock restoration failed, protection not restored: ${removal.stderr}`,
                };
            }

            dayLog("info", "released and removed a session worktree", {
                session: options.sessionId,
                worktree: worktree.root,
            });

            return { removed: true, detail: `removed ${worktree.root}` };
        }) ?? { removed: false, detail: "worktree ownership guard is busy or unavailable; nothing removed" }
    );
}

/**
 * The absolute paths a shell command names, `~/` expanded. Text only: a command that names no path
 * costs one regex and nothing else.
 */
export function shellCommandPaths(command: string): string[] {
    if (!command.includes("/")) {
        return [];
    }

    const paths = new Set<string>();

    for (const match of command
        .slice(0, MAX_COMMAND_CHARS)
        .matchAll(/(?:^|[\s'"`=(:])(~?\/[^\s'"`;|&<>()$*?[\]{}]*)/g)) {
        const token = match[1] ?? "";

        // `//host/x` is the tail of a URL; `/` alone names the whole disk.
        if (token === "/" || token.startsWith("//") || token === "~/") {
            continue;
        }

        paths.add(token.startsWith("~/") ? join(homedir(), token.slice(2)) : token);

        if (paths.size >= MAX_COMMAND_PATHS) {
            break;
        }
    }

    return [...paths];
}

/** `Bash`, `shell`, `run_terminal_command`: the same tool under three harnesses. */
function isShellTool(name: string): boolean {
    const normalized = name.toLowerCase().replace(/_/g, "");

    return normalized === "bash" || normalized === "shell" || normalized === "runterminalcommand";
}

/**
 * PostToolUse: lock the worktrees an edit or a shell call worked in. Never throws, never prints. Called
 * from `area-rules.ts` for the reason in the file comment, and from this file's own entry point.
 */
export function lockWorktreesForToolUse(payload: object, options: { agent?: AgentProcess; now?: number } = {}): void {
    try {
        const input = normalize(payload as HookInput);
        const tool = input.tool_name ?? "";

        if (input.hook_event_name !== "PostToolUse" || !input.session_id) {
            return;
        }

        let paths: string[];

        if (EDIT_TOOLS.has(tool)) {
            if (writeFailed(input.tool_response)) {
                return;
            }

            paths = filePathsOf(input);
        } else if (isShellTool(tool)) {
            const command = input.tool_input?.command;
            paths = typeof command === "string" ? shellCommandPaths(command) : [];

            if (typeof input.cwd === "string") {
                paths.push(input.cwd);
            }
        } else {
            return;
        }

        lockWorktreesForPaths({ sessionId: input.session_id, paths, ...options });
    } catch (error) {
        dayLog("error", "worktree lock failed on a tool call", { error: messageOf(error) });
    }
}

/** SessionStart: clear the stale session locks of the session's repository, then lock its worktree. */
export function lockWorktreeAtSessionStart(
    payload: object,
    options: { agent?: AgentProcess; now?: number } = {}
): Map<string, LockOutcome> {
    const input = normalize(payload as HookInput);
    const cwd = input.cwd;

    if (!input.session_id || typeof cwd !== "string") {
        return new Map();
    }

    clearStaleWorktreeLocks(cwd);

    return lockWorktreesForPaths({ sessionId: input.session_id, paths: [cwd], fresh: true, ...options });
}

/**
 * `bun worktree-lock.ts stale <repo> [--clear]` lists the stale session locks of a repository, one JSON
 * line each, and with `--clear` unlocks them. `release <worktree> --session <id>` removes a worktree whose
 * only lock is that session's (`releaseSessionWorktree`). Any other call is a hook: the payload comes on stdin.
 */
async function main(): Promise<void> {
    const [command, repo = process.cwd(), flag, value] = process.argv.slice(2);

    if (command === "release") {
        const result =
            flag === "--session" && value
                ? releaseSessionWorktree({ worktree: repo, sessionId: value })
                : { removed: false, detail: "usage: worktree-lock.ts release <worktree> --session <session id>" };
        process.stdout.write(`${SafeJSON.stringify(result)}\n`);
        process.exitCode = result.removed ? 0 : 1;

        return;
    }

    if (command === "stale") {
        const locks = flag === "--clear" ? clearStaleWorktreeLocks(repo) : findStaleWorktreeLocks(repo);

        for (const lock of locks) {
            process.stdout.write(`${SafeJSON.stringify({ worktree: lock.root, reason: lock.reason })}\n`);
        }

        return;
    }

    let parsed: unknown;

    try {
        parsed = SafeJSON.parse(await Bun.stdin.text());
    } catch {
        // Not a hook payload: nothing to do.
        return;
    }

    if (!isRecord(parsed)) {
        return;
    }

    const input = normalize(parsed as HookInput);

    if (input.hook_event_name === "SessionStart") {
        lockWorktreeAtSessionStart(parsed);
    } else if (input.hook_event_name === "SessionEnd") {
        unlockSessionWorktrees(input.session_id ?? "");
    } else if (input.hook_event_name === "PostToolUse") {
        lockWorktreesForToolUse(parsed);
    }
}

if (import.meta.main) {
    try {
        await main();
    } catch (error) {
        dayLog("error", "worktree lock hook failed", { error: messageOf(error) });

        if (process.argv[2] === "release" || process.argv[2] === "stale") {
            process.exitCode = 1;
        }
    }

    const cli = process.argv[2] === "release" || process.argv[2] === "stale";
    process.exit(cli && typeof process.exitCode === "number" ? process.exitCode : 0);
}
