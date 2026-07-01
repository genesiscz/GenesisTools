import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { getConfig, saveTtydSessions } from "@app/dev-dashboard/config";
import { makeTtydTmuxSessionName } from "@app/dev-dashboard/lib/tmux/naming";
import type { TtydSession } from "@app/dev-dashboard/lib/ttyd/types";
import { logger } from "@app/logger";
import { env } from "@app/utils/env";
import { findFreePort } from "@app/utils/net/free-port";
import { killWithEscalation } from "@app/utils/process/killWithEscalation";
import { buildTerminalSpawnEnv } from "@app/utils/terminal/locale";
import { resolveTmuxBin } from "@app/utils/tmux/bin";
import {
    createTmuxSession,
    ensureTmuxServerPersists,
    ensureTmuxSessionEnvironment,
    killTmuxSession,
    listTmuxSessionCommands,
    sessionExists,
} from "@app/utils/tmux/sessions";
import type { Subprocess } from "bun";

export { ttydLabel } from "@app/dev-dashboard/lib/ttyd/label";

type TtydChild = Subprocess<"ignore", "ignore", "ignore">;

interface Tracked {
    session: TtydSession;
    child: TtydChild | null;
}

export interface SpawnOptions {
    command?: string;
    cwd?: string;
    attachTmuxSession?: string;
}

export interface KillTtydOptions {
    killTmux?: boolean;
}

const registry = new Map<string, Tracked>();
const TTYD_BIN = "/opt/homebrew/bin/ttyd";
let hydrated = false;

function tmuxAlreadyOpenInTtyd(tmuxSessionName: string): boolean {
    for (const tracked of registry.values()) {
        if (tracked.session.tmuxSessionName === tmuxSessionName) {
            return true;
        }
    }

    return false;
}

/**
 * Verify the live process at `pid` is actually *this* ttyd session and not an
 * unrelated process that reused the PID. ttyd is spawned with a unique
 * `-b /ttyd/<id>` base path, so its argv carries the session id as a marker.
 */
function processMatchesSession(session: TtydSession): boolean {
    const result = Bun.spawnSync(["/bin/ps", "-p", String(session.pid), "-o", "command="], {
        stdio: ["ignore", "pipe", "ignore"],
    });

    if (result.exitCode !== 0) {
        return false;
    }

    const cmd = result.stdout.toString().trim();

    return cmd.includes("ttyd") && cmd.includes(`/ttyd/${session.id}`);
}

async function processMatchesSessionAsync(session: TtydSession): Promise<boolean> {
    const proc = Bun.spawn(["/bin/ps", "-p", String(session.pid), "-o", "command="], {
        stdio: ["ignore", "pipe", "ignore"],
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
        return false;
    }

    const cmd = stdout.trim();
    return cmd.includes("ttyd") && cmd.includes(`/ttyd/${session.id}`);
}

/**
 * Batched async variant — parallelizes N× `ps -p PID` across all sessions.
 * Benchmark on Apple Silicon (n=11): sync-serial 10.4ms median, async-parallel
 * 2.6ms median, sync-batch (one `ps -p PID1,PID2,…`) 43ms (macOS ps takes a
 * full-proctable slow path for multi-pid). Async-parallel is the win.
 */
async function isSessionAliveBatch(sessions: TtydSession[]): Promise<Map<string, boolean>> {
    return new Map(
        await Promise.all(
            sessions.map(async (session): Promise<[string, boolean]> => {
                if (session.pid <= 0) {
                    return [session.id, false];
                }

                try {
                    process.kill(session.pid, 0);
                } catch {
                    return [session.id, false];
                }

                return [session.id, await processMatchesSessionAsync(session)];
            })
        )
    );
}

let persistRegistryOverride: (() => Promise<void>) | null = null;

/** Test hook: replace disk persistence so spawn-failure cleanup can be exercised. */
export function __setPersistRegistryForTest(fn: (() => Promise<void>) | null): void {
    persistRegistryOverride = fn;
}

async function persistRegistry(): Promise<void> {
    if (persistRegistryOverride) {
        await persistRegistryOverride();
        return;
    }

    const all = Array.from(registry.values()).map((tracked) => tracked.session);
    const alive = await isSessionAliveBatch(all);
    const sessions = all.filter((session) => alive.get(session.id) === true);
    await saveTtydSessions(sessions);
}

async function hydrateRegistry(): Promise<void> {
    if (hydrated) {
        return;
    }

    // Don't latch `hydrated` until the config actually loads — a transient
    // read error here would otherwise permanently brick hydration.
    const config = await getConfig();
    hydrated = true;

    const fresh = config.ttydSessions.filter((session) => !registry.has(session.id));
    const alive = await isSessionAliveBatch(fresh);
    let changed = false;

    for (const session of fresh) {
        if (alive.get(session.id) === true) {
            registry.set(session.id, { session, child: null });
        } else {
            changed = true;
        }
    }

    if (changed) {
        await persistRegistry();
    }
}

// Short TTL cache so 2-3s polls (TmuxSessionsPanel @3s, /ttyd route @5s) don't each
// pay 11× `ps -p $PID` subprocess spawns. Explicit spawn/kill/onExit paths already
// mutate the registry directly, so this cache only delays detection of EXTERNAL
// deaths (ttyd crash, external kill -9); 3s of staleness is harmless — the next
// poll catches it and the front-proxy 502s the stale id in the meantime.
const PRUNE_TTL_MS = 3000;
let lastPruneAt = 0;

async function pruneDeadSessions(): Promise<void> {
    if (Date.now() - lastPruneAt < PRUNE_TTL_MS) {
        return;
    }

    const all = Array.from(registry.values()).map((tracked) => tracked.session);
    const alive = await isSessionAliveBatch(all);
    let changed = false;

    for (const session of all) {
        if (alive.get(session.id) !== true) {
            registry.delete(session.id);
            changed = true;
        }
    }

    lastPruneAt = Date.now();

    if (changed) {
        await persistRegistry();
    }
}

async function stopTtydProcess(tracked: Tracked, id: string): Promise<void> {
    if (tracked.child) {
        await killWithEscalation(tracked.child);
        return;
    }

    if (!processMatchesSession(tracked.session)) {
        logger.debug({ id, pid: tracked.session.pid }, "ttyd pid no longer ours; skipping kill");
        return;
    }

    const pid = tracked.session.pid;

    try {
        await killWithEscalation({
            kill(signal) {
                process.kill(pid, signal);
            },
            on(event, listener) {
                if (event !== "exit") {
                    return;
                }

                const poll = (): void => {
                    try {
                        process.kill(pid, 0);
                        setTimeout(poll, 200);
                    } catch (err) {
                        // ESRCH means the process is actually gone; anything else (e.g. EPERM,
                        // pid reused by a process we can't signal) means it's still alive.
                        if (err && typeof err === "object" && "code" in err && err.code === "ESRCH") {
                            listener();
                        } else {
                            setTimeout(poll, 200);
                        }
                    }
                };

                poll();
            },
        });
    } catch (err) {
        logger.debug({ err, id }, "ttyd process already gone");
    }
}

export async function spawnTtyd(opts: SpawnOptions = {}): Promise<TtydSession> {
    await hydrateRegistry();

    if (!existsSync(TTYD_BIN)) {
        throw new Error(`ttyd not found at ${TTYD_BIN}`);
    }

    const tmuxBin = resolveTmuxBin();
    const rawCommand = opts.command ?? env.paths.getShell("/bin/zsh");
    const command = rawCommand.trim().length > 0 && !rawCommand.includes("=") ? rawCommand.trim() : "/bin/zsh";
    const cwd = opts.cwd ?? process.cwd();
    const port = await findFreePort();
    const id = randomUUID();

    let tmuxSessionName: string;

    if (opts.attachTmuxSession) {
        if (!sessionExists(opts.attachTmuxSession)) {
            throw new Error(`tmux session ${opts.attachTmuxSession} does not exist`);
        }

        if (tmuxAlreadyOpenInTtyd(opts.attachTmuxSession)) {
            const err = new Error(`tmux session ${opts.attachTmuxSession} is already open in ttyd`);
            (err as Error & { statusCode?: number }).statusCode = 409;
            throw err;
        }

        tmuxSessionName = opts.attachTmuxSession;
        ensureTmuxSessionEnvironment(tmuxSessionName);
        // Re-pin the server even when attaching to a pre-existing session — it may
        // have been bootstrapped (by an older dashboard) with exit-empty on.
        ensureTmuxServerPersists();
    } else {
        tmuxSessionName = makeTtydTmuxSessionName(id);
        createTmuxSession(tmuxSessionName, cwd, command);
    }

    // Bind loopback-only and serve under /ttyd/<id> so the Bun.serve front
    // proxy can reverse-proxy it same-origin (HTTPS tunnel + mobile, where a
    // bare http://localhost:<port> iframe is unreachable). The base-path makes
    // ttyd emit correctly-prefixed asset/ws URLs so no path rewriting needed.
    const child: TtydChild = Bun.spawn({
        cmd: [
            TTYD_BIN,
            "-i",
            "127.0.0.1",
            "-b",
            `/ttyd/${id}`,
            "-W",
            "-p",
            String(port),
            tmuxBin,
            "attach-session",
            "-t",
            tmuxSessionName,
        ],
        cwd,
        env: buildTerminalSpawnEnv(),
        stdio: ["ignore", "ignore", "ignore"],
        detached: true,
        onExit(_proc, code, signal, err) {
            if (err) {
                logger.error({ err, id, port }, "ttyd child error");
            }

            logger.debug({ id, port, code, signal }, "ttyd child exited");
            registry.delete(id);
            void persistRegistry().catch((persistErr) => {
                logger.warn({ err: persistErr, id, port }, "failed to persist ttyd registry after child exit");
            });
        },
    });

    // ttyd must outlive the dashboard. detached: true runs setsid() so ttyd
    // gets its own process group and does not take the SIGHUP delivered to the
    // dashboard's group on exit; unref() additionally frees the parent event
    // loop so the dashboard can exit cleanly while ttyd keeps running.
    child.unref();

    const session: TtydSession = {
        id,
        port,
        command,
        cwd,
        pid: child.pid,
        startedAt: new Date().toISOString(),
        tmuxSessionName,
    };
    try {
        registry.set(id, { session, child });
        await persistRegistry();
    } catch (err) {
        registry.delete(id);
        child.kill();
        await child.exited;
        logger.error({ err, id }, "[ttyd] registry persist failed after spawn; killed orphaned child");
        throw err;
    }

    logger.info({ id, port, command, cwd, tmuxSessionName, attach: Boolean(opts.attachTmuxSession) }, "ttyd spawned");

    return session;
}

export async function listTtyd(): Promise<TtydSession[]> {
    await hydrateRegistry();
    await pruneDeadSessions();

    // Refresh each session's live `lastCommand` from its bound tmux session (one list-sessions call,
    // shared across all sessions). Drives the auto-name; a manual `name` still wins downstream.
    const commandByTmux = listTmuxSessionCommands();

    return Array.from(registry.values()).map((tracked) => {
        const { session } = tracked;
        const lastCommand = session.tmuxSessionName ? commandByTmux.get(session.tmuxSessionName) : undefined;

        return { ...session, lastCommand };
    });
}

/**
 * Resolve a session's port. The front-proxy (a *separate* process from the
 * vite-middleware that runs `spawnTtyd`) hits this for every /ttyd/<id>/*
 * request, so the hit path stays in-memory — no per-request disk I/O.
 *
 * But `hydrateRegistry()` latches `hydrated` for the process lifetime and the
 * registry Map is per-process: a terminal spawned by the vite-middleware
 * process *after* the proxy process hydrated is in config but absent from the
 * proxy's registry, so a pure in-memory lookup 502s ("session not found")
 * forever — even across hard refreshes. On a miss, fall back to one fresh
 * config read so cross-process / post-hydrate sessions resolve. Hits never
 * touch disk; only the (rare, first-load) miss does.
 */
export async function getTtydPort(id: string): Promise<number | null> {
    await hydrateRegistry();

    const cachedPort = registry.get(id)?.session.port;
    if (cachedPort !== undefined) {
        return cachedPort;
    }

    const config = await getConfig();
    return config.ttydSessions.find((session) => session.id === id)?.port ?? null;
}

/**
 * Resolve a session's tmux session name. Like getTtydPort, this is on the hit
 * path of frequent polling (the scrollbar reads tmux state), so it stays
 * in-memory with a single config fallback for cross-process / post-hydrate
 * sessions — no per-call prune.
 */
export async function getTtydTmuxSessionName(id: string): Promise<string | null> {
    await hydrateRegistry();

    const cached = registry.get(id)?.session.tmuxSessionName;
    if (cached !== undefined) {
        return cached;
    }

    const config = await getConfig();
    return config.ttydSessions.find((session) => session.id === id)?.tmuxSessionName ?? null;
}

export async function renameTtyd(id: string, name: string): Promise<boolean> {
    await hydrateRegistry();
    const tracked = registry.get(id);

    if (!tracked) {
        return false;
    }

    const trimmed = name.trim();
    tracked.session.name = trimmed.length > 0 ? trimmed : undefined;
    await persistRegistry();
    logger.info({ id, name: tracked.session.name }, "ttyd renamed");

    return true;
}

export async function retargetTtydTmuxBindings(fromName: string, toName: string): Promise<void> {
    await hydrateRegistry();

    let changed = false;

    for (const tracked of registry.values()) {
        if (tracked.session.tmuxSessionName === fromName) {
            tracked.session.tmuxSessionName = toName;
            changed = true;
        }
    }

    if (changed) {
        await persistRegistry();
        logger.info({ fromName, toName }, "retargeted ttyd tmux bindings after rename");
    }
}

export async function killTtyd(id: string, opts: KillTtydOptions = {}): Promise<boolean> {
    await hydrateRegistry();

    const tracked = registry.get(id);

    if (!tracked) {
        return false;
    }

    await stopTtydProcess(tracked, id);

    if (opts.killTmux && tracked.session.tmuxSessionName) {
        killTmuxSession(tracked.session.tmuxSessionName);
    }

    registry.delete(id);
    await persistRegistry();

    return true;
}

export async function killAllTtyd(): Promise<void> {
    // After a dashboard restart the in-memory registry is empty but sessions
    // persist in config; hydrate first so they're actually terminated.
    await hydrateRegistry();

    for (const [id, tracked] of registry.entries()) {
        await stopTtydProcess(tracked, id);
    }

    registry.clear();
    await persistRegistry();
}
