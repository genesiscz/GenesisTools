import { existsSync, readFileSync, renameSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { type CaptureResult, capture, parseCpuTime } from "@genesiscz/utils/process/ps";
import { toolDataDir } from "@genesiscz/utils/storage/root";

/**
 * git's file system monitor, turned on in the global config and kept track of.
 *
 * With `core.fsmonitor=true` git starts one `git fsmonitor--daemon` per worktree on its first status there, and the
 * daemon answers "what changed" from FSEvents instead of git stat'ing every index entry. With
 * `core.untrackedCache=true` git also keeps the untracked-file scan in the index. Measured 2026-10-12 on a 9,278-file
 * clone: a status costs 8.6 to 9.3 ms of CPU against 49 ms without either.
 *
 * A daemon runs until its worktree disappears (it exits within a second of the folder being moved or deleted) or
 * until `git fsmonitor--daemon stop`. Its working folder is the home folder; only its socket,
 * `<git dir>/fsmonitor--daemon.ipc`, names the worktree it watches.
 */

/** The two settings `enable` turns on in the global git config. */
export const FSMONITOR_KEYS = ["core.fsmonitor", "core.untrackedCache"] as const;
export type FsmonitorKey = (typeof FSMONITOR_KEYS)[number];

export interface FsmonitorState {
    version: 1;
    /** When `enable` last ran; null when it is off. */
    enabledAt: string | null;
    /** The global values before `enable`, which `disable` puts back. A null value means the key was not set. */
    previous: Record<FsmonitorKey, string | null> | null;
    /** Every worktree a daemon was seen watching, so `disable` can clean all of them. */
    worktrees: Record<string, { firstSeen: string; lastSeen: string }>;
}

export interface MonitorDaemon {
    pid: number;
    /** The worktree the daemon watches; null when its socket could not be read. */
    worktree: string | null;
    rssKb: number;
    cpuMs: number | null;
}

type Run = (
    command: string,
    args: string[],
    options?: { env?: Record<string, string | undefined>; timeoutMs?: number }
) => Promise<CaptureResult>;

export interface FsmonitorDeps {
    run: Run;
    statePath: string;
    /** Another global git config file instead of `~/.gitconfig`; tests only. */
    globalConfigPath?: string;
    now: () => Date;
}

export function defaultFsmonitorDeps(): FsmonitorDeps {
    return {
        run: (command, args, options) => capture(command, args, { timeoutMs: 15_000, ...options }),
        statePath: toolDataDir("git", "fsmonitor.json"),
        now: () => new Date(),
    };
}

function emptyState(): FsmonitorState {
    return { version: 1, enabledAt: null, previous: null, worktrees: {} };
}

function isState(value: unknown): value is FsmonitorState {
    return (
        typeof value === "object" &&
        value !== null &&
        "version" in value &&
        value.version === 1 &&
        "worktrees" in value &&
        typeof value.worktrees === "object" &&
        value.worktrees !== null
    );
}

export function readFsmonitorState(path: string): FsmonitorState {
    if (!existsSync(path)) {
        return emptyState();
    }

    try {
        const parsed: unknown = SafeJSON.parse(readFileSync(path, "utf8"));

        if (isState(parsed)) {
            return parsed;
        }

        logger.warn({ path }, "[git fsmonitor] state file has an unknown shape; treating it as empty");
    } catch (error) {
        logger.warn({ error, path }, "[git fsmonitor] state file unreadable; treating it as empty");
    }

    return emptyState();
}

async function writeState(path: string, state: FsmonitorState): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await Bun.write(temporary, SafeJSON.stringify(state, null, 2));
    renameSync(temporary, path);
}

function gitEnv(deps: FsmonitorDeps): Record<string, string | undefined> | undefined {
    return deps.globalConfigPath ? { ...env.getProcessEnv(), GIT_CONFIG_GLOBAL: deps.globalConfigPath } : undefined;
}

async function git(deps: FsmonitorDeps, args: string[]): Promise<CaptureResult> {
    const result = await deps.run("git", args, { env: gitEnv(deps) });
    logger.debug({ args, status: result.status }, "[git fsmonitor] git");
    return result;
}

/** A global value, or null when the key is not set. */
export async function readGlobal(deps: FsmonitorDeps, key: FsmonitorKey): Promise<string | null> {
    const result = await git(deps, ["config", "--global", "--get", key]);

    if (result.status === 0) {
        return result.stdout.trim();
    }

    if (result.status === 1) {
        return null;
    }

    throw new Error(`git config --global --get ${key} failed (${result.status}): ${result.stderr.trim()}`);
}

async function writeGlobal(deps: FsmonitorDeps, key: FsmonitorKey, value: string | null): Promise<void> {
    const args = value === null ? ["config", "--global", "--unset-all", key] : ["config", "--global", key, value];
    const result = await git(deps, args);

    // 5 = `--unset-all` of a key that is not set, which is already the wanted state.
    if (result.status !== 0 && !(value === null && result.status === 5)) {
        throw new Error(`git ${args.join(" ")} failed (${result.status}): ${result.stderr.trim()}`);
    }
}

/** The worktree of a daemon socket `<git dir>/fsmonitor--daemon.ipc`. */
export function worktreeOfSocket(socketPath: string): string {
    const gitDir = dirname(socketPath);

    if (basename(gitDir) === ".git") {
        return dirname(gitDir);
    }

    // A linked worktree's git dir is `<main>/.git/worktrees/<name>`; its `gitdir` file names `<worktree>/.git`.
    const pointer = join(gitDir, "gitdir");

    if (existsSync(pointer)) {
        const target = readFileSync(pointer, "utf8").trim();
        return dirname(isAbsolute(target) ? target : resolve(gitDir, target));
    }

    return gitDir;
}

/** Every running `git fsmonitor--daemon`, with the worktree it watches. One `ps`, then one `lsof` for those pids. */
export async function listMonitorDaemons(deps: FsmonitorDeps): Promise<MonitorDaemon[]> {
    const ps = await deps.run("ps", ["-Ao", "pid=,rss=,time=,command="]);

    if (ps.status !== 0) {
        throw new Error(`ps failed (${ps.status}): ${ps.stderr.trim()}`);
    }

    const daemons: MonitorDaemon[] = [];

    for (const line of ps.stdout.split("\n")) {
        const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);

        if (!match || !/\bfsmonitor--daemon run\b/.test(match[4])) {
            continue;
        }

        daemons.push({
            pid: Number(match[1]),
            worktree: null,
            rssKb: Number(match[2]),
            cpuMs: parseCpuTime(match[3]),
        });
    }

    if (daemons.length === 0) {
        return daemons;
    }

    // Every open file of these pids except the working folder (always the home folder). Exit 1 means none matched.
    const lsof = await deps.run("lsof", [
        "-a",
        "-p",
        daemons.map((daemon) => daemon.pid).join(","),
        "-d",
        "^cwd",
        "-F",
        "pftn",
    ]);
    const worktrees = worktreesFromLsof(lsof.stdout);

    if (worktrees.size < daemons.length) {
        logger.debug({ daemons: daemons.length, found: worktrees.size, status: lsof.status }, "[git fsmonitor] lsof");
    }

    return daemons.map((daemon) => ({ ...daemon, worktree: worktrees.get(daemon.pid) ?? null }));
}

/**
 * The worktree of each daemon in `lsof -F pftn` output. A daemon holds an open handle on its worktree folder and on
 * every folder above it, and opens the worktree first, so the folder with the lowest fd number is the worktree. Its
 * socket is the fallback: a main checkout binds `<worktree>/.git/fsmonitor--daemon.ipc` by its full path, but a
 * linked worktree binds the bare name `fsmonitor--daemon.ipc`, which names nothing.
 */
export function worktreesFromLsof(output: string): Map<number, string> {
    const firstFolder = new Map<number, { fd: number; path: string }>();
    const sockets = new Map<number, string>();
    let pid = 0;
    let fd = Number.NaN;
    let type = "";

    for (const line of output.split("\n")) {
        const field = line[0];
        const value = line.slice(1);

        if (field === "p") {
            pid = Number(value);
        } else if (field === "f") {
            fd = Number(value);
            type = "";
        } else if (field === "t") {
            type = value;
        } else if (field === "n" && type === "DIR" && Number.isInteger(fd)) {
            const known = firstFolder.get(pid);

            if (!known || fd < known.fd) {
                firstFolder.set(pid, { fd, path: value });
            }
        } else if (field === "n" && value.startsWith("/") && value.endsWith("/fsmonitor--daemon.ipc")) {
            sockets.set(pid, value);
        }
    }

    const worktrees = new Map<number, string>();

    for (const [daemonPid, folder] of firstFolder) {
        worktrees.set(daemonPid, folder.path);
    }

    for (const [daemonPid, socket] of sockets) {
        if (!worktrees.has(daemonPid)) {
            worktrees.set(daemonPid, worktreeOfSocket(socket));
        }
    }

    return worktrees;
}

/** Adds every watched worktree to the state file. The daemon task runs this every 10 minutes. */
export async function recordMonitorDaemons(
    deps: FsmonitorDeps
): Promise<{ daemons: MonitorDaemon[]; added: string[]; recorded: number }> {
    const daemons = await listMonitorDaemons(deps);
    const state = readFsmonitorState(deps.statePath);
    const now = deps.now().toISOString();
    const added: string[] = [];

    for (const { worktree } of daemons) {
        if (!worktree) {
            continue;
        }

        const known = state.worktrees[worktree];

        if (!known) {
            added.push(worktree);
        }

        state.worktrees[worktree] = { firstSeen: known?.firstSeen ?? now, lastSeen: now };
    }

    if (daemons.some((daemon) => daemon.worktree)) {
        await writeState(deps.statePath, state);
    }

    return { daemons, added, recorded: Object.keys(state.worktrees).length };
}

/** Turns both settings on globally, keeping the earlier values for `disable`. Safe to run twice. */
export async function enableFsmonitor(
    deps: FsmonitorDeps
): Promise<{ previous: Record<FsmonitorKey, string | null>; alreadyEnabled: boolean }> {
    const state = readFsmonitorState(deps.statePath);
    const alreadyEnabled = state.previous !== null;
    const previous = state.previous ?? {
        "core.fsmonitor": await readGlobal(deps, "core.fsmonitor"),
        "core.untrackedCache": await readGlobal(deps, "core.untrackedCache"),
    };

    // The state is written first: if a write to the git config fails half way, `disable` still knows what to restore.
    await writeState(deps.statePath, { ...state, previous, enabledAt: deps.now().toISOString() });

    for (const key of FSMONITOR_KEYS) {
        await writeGlobal(deps, key, "true");
    }

    logger.info({ previous, alreadyEnabled }, "[git fsmonitor] enabled globally");
    return { previous, alreadyEnabled };
}

export interface DisableReport {
    restored: Record<FsmonitorKey, string | null>;
    stopped: string[];
    cacheRemoved: string[];
    missing: string[];
    failed: Array<{ worktree: string; step: string; error: string }>;
}

/**
 * Turns it off and cleans up: puts the global values back FIRST (so no git command starts a new daemon meanwhile),
 * then stops the daemon of every recorded or running worktree and removes the untracked cache from its index.
 */
export async function disableFsmonitor(deps: FsmonitorDeps, { keepCache = false } = {}): Promise<DisableReport> {
    const state = readFsmonitorState(deps.statePath);
    const restored = state.previous ?? { "core.fsmonitor": null, "core.untrackedCache": null };

    for (const key of FSMONITOR_KEYS) {
        await writeGlobal(deps, key, restored[key]);
    }

    const daemons = await listMonitorDaemons(deps);
    const worktrees = new Set([
        ...Object.keys(state.worktrees),
        ...daemons.flatMap((daemon) => (daemon.worktree ? [daemon.worktree] : [])),
    ]);
    const running = new Set(daemons.map((daemon) => daemon.worktree));
    const report: DisableReport = { restored, stopped: [], cacheRemoved: [], missing: [], failed: [] };
    // A cache the user had turned on before stays; only one this tool added is removed.
    const removeCache = !keepCache && restored["core.untrackedCache"] !== "true";

    for (const worktree of [...worktrees].sort()) {
        if (!existsSync(worktree)) {
            report.missing.push(worktree);
            continue;
        }

        if (running.has(worktree)) {
            const stop = await git(deps, ["-C", worktree, "fsmonitor--daemon", "stop"]);

            if (stop.status === 0) {
                report.stopped.push(worktree);
            } else {
                report.failed.push({ worktree, step: "stop", error: stop.stderr.trim() });
            }
        }

        if (removeCache) {
            const cache = await git(deps, ["-C", worktree, "update-index", "--no-untracked-cache"]);

            if (cache.status === 0) {
                report.cacheRemoved.push(worktree);
            } else {
                report.failed.push({ worktree, step: "untracked cache", error: cache.stderr.trim() });
            }
        }
    }

    const failedWorktrees = new Set(report.failed.map((failure) => failure.worktree));
    const kept = Object.fromEntries(Object.entries(state.worktrees).filter(([path]) => failedWorktrees.has(path)));
    await writeState(deps.statePath, { version: 1, enabledAt: null, previous: null, worktrees: kept });
    logger.info(
        { stopped: report.stopped.length, cacheRemoved: report.cacheRemoved.length, failed: report.failed },
        "[git fsmonitor] disabled"
    );

    return report;
}
