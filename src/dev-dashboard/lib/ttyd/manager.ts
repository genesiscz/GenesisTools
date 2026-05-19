import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { getConfig, saveTtydSessions } from "@app/dev-dashboard/config";
import { findFreePort } from "@app/dev-dashboard/lib/ttyd/free-port";
import type { TtydSession } from "@app/dev-dashboard/lib/ttyd/types";
import { logger } from "@app/logger";
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
}

const registry = new Map<string, Tracked>();
const TTYD_BIN = "/opt/homebrew/bin/ttyd";
const TMUX_BIN = "/opt/homebrew/bin/tmux";
let hydrated = false;

function makeTmuxSessionName(id: string): string {
    return `dev-dashboard-${id.slice(0, 8)}`;
}

function killTmuxSession(sessionName: string): void {
    Bun.spawnSync([TMUX_BIN, "kill-session", "-t", sessionName], { stdio: ["ignore", "ignore", "ignore"] });
}

function createTmuxSession(sessionName: string, cwd: string, command: string): void {
    const result = Bun.spawnSync([TMUX_BIN, "new-session", "-d", "-s", sessionName, "-c", cwd, command], {
        cwd,
        stdio: ["ignore", "ignore", "ignore"],
    });

    if (result.exitCode !== 0) {
        throw new Error(`Failed to create tmux session ${sessionName}`);
    }
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

function isSessionAlive(session: TtydSession): boolean {
    if (session.pid <= 0) {
        return false;
    }

    try {
        process.kill(session.pid, 0);
    } catch {
        return false;
    }

    // PID exists, but PIDs are reused — confirm it's still our ttyd before
    // treating the entry as alive (and, by extension, before signalling it).
    return processMatchesSession(session);
}

async function persistRegistry(): Promise<void> {
    const sessions = Array.from(registry.values())
        .map((tracked) => tracked.session)
        .filter((session) => isSessionAlive(session));
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
    let changed = false;

    for (const session of config.ttydSessions) {
        if (registry.has(session.id)) {
            continue;
        }

        if (isSessionAlive(session)) {
            registry.set(session.id, { session, child: null });
        } else {
            changed = true;
        }
    }

    if (changed) {
        await persistRegistry();
    }
}

async function pruneDeadSessions(): Promise<void> {
    let changed = false;

    for (const [id, tracked] of registry.entries()) {
        if (!isSessionAlive(tracked.session)) {
            if (tracked.session.tmuxSessionName) {
                killTmuxSession(tracked.session.tmuxSessionName);
            }

            registry.delete(id);
            changed = true;
        }
    }

    if (changed) {
        await persistRegistry();
    }
}

export async function spawnTtyd(opts: SpawnOptions = {}): Promise<TtydSession> {
    await hydrateRegistry();

    if (!existsSync(TTYD_BIN)) {
        throw new Error(`ttyd not found at ${TTYD_BIN}`);
    }

    if (!existsSync(TMUX_BIN)) {
        throw new Error(`tmux not found at ${TMUX_BIN}`);
    }

    const command = opts.command ?? process.env.SHELL ?? "/bin/zsh";
    const cwd = opts.cwd ?? process.cwd();
    const port = await findFreePort();
    const id = randomUUID();
    const tmuxSessionName = makeTmuxSessionName(id);
    createTmuxSession(tmuxSessionName, cwd, command);
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
            TMUX_BIN,
            "attach-session",
            "-t",
            tmuxSessionName,
        ],
        cwd,
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
    registry.set(id, { session, child });
    await persistRegistry();
    logger.info({ id, port, command, cwd }, "ttyd spawned");

    return session;
}

export async function listTtyd(): Promise<TtydSession[]> {
    await hydrateRegistry();
    await pruneDeadSessions();

    return Array.from(registry.values()).map((tracked) => tracked.session);
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

export async function killTtyd(id: string): Promise<boolean> {
    await hydrateRegistry();

    const tracked = registry.get(id);

    if (!tracked) {
        return false;
    }

    if (tracked.child) {
        tracked.child.kill("SIGTERM");
    } else if (processMatchesSession(tracked.session)) {
        try {
            process.kill(tracked.session.pid, "SIGTERM");
        } catch (err) {
            logger.debug({ err, id }, "ttyd process already gone");
        }
    } else {
        logger.debug({ id, pid: tracked.session.pid }, "ttyd pid no longer ours; skipping kill");
    }

    if (tracked.session.tmuxSessionName) {
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

    for (const { child, session } of registry.values()) {
        if (child) {
            child.kill("SIGTERM");
        } else if (processMatchesSession(session)) {
            try {
                process.kill(session.pid, "SIGTERM");
            } catch (err) {
                logger.debug({ err, id: session.id }, "ttyd process already gone");
            }
        } else {
            logger.debug({ id: session.id, pid: session.pid }, "ttyd pid no longer ours; skipping kill");
        }

        if (session.tmuxSessionName) {
            killTmuxSession(session.tmuxSessionName);
        }
    }

    registry.clear();
    await persistRegistry();
}
