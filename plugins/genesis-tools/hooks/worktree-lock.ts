#!/usr/bin/env bun
/**
 * A running agent session locks every linked git worktree it works in, so `git worktree remove`
 * from another session refuses it (git needs `-f -f` for a locked worktree). The session unlocks
 * its worktrees when it ends. Asked for on 2026-10-13, after cleanup sessions removed worktrees that
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
import {
    appendFileSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
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
 * What `pid` is now, from one `ps -o etime=,command=` call (about 6 ms): "gone" when no process has it,
 * "unknown" when ps itself failed, else whether the process is claude, codex or grok and when it started.
 * A bare kill(pid, 0) cannot tell the lock's agent from a recycled pid that another program now holds.
 */
function checkProcess(pid: number, now: number): ProcessCheck {
    // pid 0 and below are process groups, and pid 1 is launchd: none names a session.
    if (!Number.isInteger(pid) || pid <= 1) {
        return { state: "gone" };
    }

    const result = Bun.spawnSync(["ps", "-o", "etime=,command=", "-p", String(pid)], {
        stdout: "pipe",
        stderr: "ignore",
        timeout: SPAWN_TIMEOUT_MS,
    });
    const out = result.stdout.toString().trim();

    // `ps -p` of a pid no process has prints nothing and exits 1.
    if (result.exitCode === 1 && out === "") {
        return { state: "gone" };
    }

    // etime is `[[dd-]hh:]mm:ss`.
    const match = result.exitCode === 0 ? /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)\s+(.*)$/s.exec(out) : null;

    if (!match) {
        return { state: "unknown" };
    }

    const [, days = "0", hours = "0", minutes = "0", seconds = "0", command = ""] = match;
    const elapsedSeconds = ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds);

    return { state: "live", agent: agentNamed(command) !== null, startMs: now - elapsedSeconds * 1000 };
}

/** Whether `pid` is still a running agent. When ps cannot answer, it counts as alive: a wrong "dead" frees a worktree in use. */
function agentAlive(pid: number, now = Date.now()): boolean {
    const check = checkProcess(pid, now);

    return check.state === "unknown" || (check.state === "live" && check.agent);
}

/**
 * Whether a lock's owner is gone. A hand lock never is. A session lock is stale when its pid is dead,
 * when another program now holds the pid, or when the pid started after the lock was taken (a reused
 * pid). Claude Code's own lock carries no time we can compare, so only its pid and program count. When
 * `ps` cannot answer, the lock is kept: a wrong "stale" lets a worktree in use be removed.
 */
export function isLockStale(holder: LockHolder, options: { now?: number } = {}): boolean {
    const { now = Date.now() } = options;

    if (holder.kind === "other") {
        return false;
    }

    const check = checkProcess(holder.pid, now);

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

function git(commonDir: string, args: string[]): { ok: boolean; stderr: string } {
    const result = Bun.spawnSync(["git", `--git-dir=${commonDir}`, ...args], {
        stdout: "ignore",
        stderr: "pipe",
        env: gitEnv(),
        timeout: SPAWN_TIMEOUT_MS,
    });

    return { ok: result.exitCode === 0, stderr: result.stderr.toString().trim() };
}

/**
 * Unlock a worktree whose lock still reads `expectedReason`. git finds the worktree by its folder,
 * so a folder moved with plain `mv` makes `git worktree unlock` fail. Then the `locked` file is
 * removed directly, which is all git itself does, and only while it still holds the reason we checked.
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
 * runs `ps`; it never changes a lock. `clearStaleWorktreeLocks` is the step that acts on it.
 */
export function findStaleWorktreeLocks(repoPath: string, now = Date.now()): StaleLock[] {
    const commonDir = commonDirOf(repoPath);

    if (!commonDir) {
        return [];
    }

    const stale: StaleLock[] = [];

    for (const { reason, ...worktree } of registeredWorktrees(commonDir)) {
        if (reason !== null && isLockStale(parseLockReason(reason), { now })) {
            stale.push({ ...worktree, reason });
        }
    }

    return stale;
}

/** Unlock what `findStaleWorktreeLocks` reports, each only while its reason is still the one it read. */
export function clearStaleWorktreeLocks(repoPath: string, now = Date.now()): StaleLock[] {
    const cleared: StaleLock[] = [];

    for (const lock of findStaleWorktreeLocks(repoPath, now)) {
        if (unlockWorktree(lock, lock.reason)) {
            cleared.push(lock);
            dayLog("info", "cleared a stale worktree lock", { worktree: lock.root, reason: lock.reason });
        }
    }

    return cleared;
}

function recordPath(sessionId: string): string {
    return join(genesisHome(), ".genesis-tools", "claude-code", "worktree-locks", `${sessionId}.json`);
}

function readRecord(sessionId: string): LockRecord | null {
    let parsed: unknown;

    try {
        parsed = SafeJSON.parse(readFileSync(recordPath(sessionId), "utf8"));
    } catch (error) {
        if (errorCode(error) !== "ENOENT") {
            dayLog("warn", "unreadable worktree-lock record, starting a new one", {
                session: sessionId,
                error: messageOf(error),
            });
        }

        return null;
    }

    const harness = isRecord(parsed) ? harnessNamed(parsed.harness) : null;

    if (!isRecord(parsed) || !harness || typeof parsed.pid !== "number" || !Array.isArray(parsed.locks)) {
        return null;
    }

    const locks = parsed.locks.filter(
        (lock): lock is RecordedLock =>
            isRecord(lock) &&
            typeof lock.root === "string" &&
            typeof lock.adminDir === "string" &&
            typeof lock.commonDir === "string"
    );

    return { session_id: sessionId, harness, pid: parsed.pid, locks };
}

/**
 * Temp-then-rename, and the locks of a record another hook of this session wrote meanwhile are kept.
 * Two hooks writing in the same millisecond can still lose an entry; SessionEnd also scans the
 * recorded repositories for this session's id, so the lock is released anyway.
 */
function writeRecord(record: LockRecord): void {
    const path = recordPath(record.session_id);
    const merged = new Map((readRecord(record.session_id)?.locks ?? []).map((lock) => [lock.adminDir, lock]));

    for (const lock of record.locks) {
        merged.set(lock.adminDir, lock);
    }

    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.tmp.${process.pid}`;
    writeFileSync(temp, SafeJSON.stringify({ ...record, locks: [...merged.values()] }, null, 2));
    renameSync(temp, path);
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
 * A hook runs under a shell, so its parent is rarely the agent itself. One `ps -p` per level, about
 * 6 ms each; `ps -A` costs 90 ms. The nearest one is right also for a Codex worker started from a
 * Claude session, whose chain holds both.
 */
export function findAgentProcess(startPid = process.ppid): AgentProcess | null {
    let pid = startPid;

    for (let depth = 0; depth < MAX_ANCESTORS && pid > 1; depth++) {
        const result = Bun.spawnSync(["ps", "-o", "ppid=,command=", "-p", String(pid)], {
            stdout: "pipe",
            stderr: "ignore",
            timeout: SPAWN_TIMEOUT_MS,
        });
        const match = result.exitCode === 0 ? /^\s*(\d+)\s+(.*)$/s.exec(result.stdout.toString().trim()) : null;

        if (!match) {
            return null;
        }

        const harness = agentNamed(match[2] ?? "");

        if (harness) {
            return { harness, pid };
        }

        pid = Number(match[1]);
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
    const added: RecordedLock[] = [];

    for (const worktree of worktrees.values()) {
        const current = readLockReason(worktree.adminDir);
        const holder = current === null ? null : parseLockReason(current);

        if (holder?.kind === "session" && holder.sessionId === sessionId) {
            // This session's lock under the pid it recorded: a hook only runs in a live session, so a
            // repeat call trusts that and spawns nothing.
            if (!agent && record === undefined) {
                record = readRecord(sessionId);
            }

            const owner = agent?.pid ?? record?.pid;

            if (holder.pid === owner && (!fresh || agentAlive(holder.pid, now))) {
                outcomes.set(worktree.root, "ours");
                continue;
            }
        }

        if (holder && !isLockStale(holder, { now })) {
            outcomes.set(worktree.root, "held");
            continue;
        }

        if (!agent) {
            record ??= readRecord(sessionId);
            agent =
                record && agentAlive(record.pid, now)
                    ? { harness: record.harness, pid: record.pid }
                    : findAgentProcess();
        }

        if (!agent) {
            dayLog("warn", "no claude, codex or grok process above this hook; the worktree stays unlocked", {
                session: sessionId,
                worktree: worktree.root,
            });
            break;
        }

        if (current !== null && !unlockWorktree(worktree, current)) {
            outcomes.set(worktree.root, "held");
            continue;
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
            outcomes.set(worktree.root, "held");
            continue;
        }

        dayLog("info", "locked a worktree for this session", { worktree: worktree.root, reason });
        outcomes.set(worktree.root, "locked");
        added.push({ ...worktree, pid: agent.pid, at: since.toISOString() });
    }

    if (agent && added.length > 0) {
        writeRecord({ session_id: sessionId, harness: agent.harness, pid: agent.pid, locks: added });
    }

    return outcomes;
}

/**
 * SessionEnd: unlock every worktree whose lock names this session, from the record plus a scan of the
 * repositories it names. A lock of this session that another live process of the same session holds
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

    for (const worktree of candidates.values()) {
        const reason = readLockReason(worktree.adminDir);
        const holder = reason === null ? null : parseLockReason(reason);

        if (
            reason !== null &&
            holder?.kind === "session" &&
            holder.sessionId === sessionId &&
            (holder.pid === record.pid || !agentAlive(holder.pid)) &&
            unlockWorktree(worktree, reason)
        ) {
            unlocked.push(worktree.root);
        }
    }

    if (unlocked.length > 0) {
        dayLog("info", "session ended; unlocked its worktrees", { session: sessionId, worktrees: unlocked });
    }

    try {
        unlinkSync(recordPath(sessionId));
    } catch (error) {
        if (errorCode(error) !== "ENOENT") {
            dayLog("warn", "cannot remove the worktree-lock record", { session: sessionId, error: messageOf(error) });
        }
    }

    return unlocked;
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

    clearStaleWorktreeLocks(cwd, options.now);

    return lockWorktreesForPaths({ sessionId: input.session_id, paths: [cwd], fresh: true, ...options });
}

/**
 * `bun worktree-lock.ts stale <repo> [--clear]` lists the stale session locks of a repository, one JSON
 * line each, and with `--clear` unlocks them. Any other call is a hook: the payload comes on stdin.
 */
async function main(): Promise<void> {
    const [command, repo = process.cwd(), flag] = process.argv.slice(2);

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
    }

    process.exit(0);
}
