import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { getConfig, saveTtydSessions } from "@app/dev-dashboard/config";
import { findFreePort } from "@app/dev-dashboard/lib/ttyd/free-port";
import type { TtydSession } from "@app/dev-dashboard/lib/ttyd/types";
import logger from "@app/logger";

interface Tracked {
    session: TtydSession;
    child: ChildProcess | null;
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
    spawnSync(TMUX_BIN, ["kill-session", "-t", sessionName], { stdio: "ignore" });
}

function createTmuxSession(sessionName: string, cwd: string, command: string): void {
    const result = spawnSync(TMUX_BIN, ["new-session", "-d", "-s", sessionName, "-c", cwd, command], {
        cwd,
        stdio: "ignore",
    });

    if (result.status !== 0) {
        throw new Error(`Failed to create tmux session ${sessionName}`);
    }
}

function isSessionAlive(session: TtydSession): boolean {
    if (session.pid <= 0) {
        return false;
    }

    try {
        process.kill(session.pid, 0);
        return true;
    } catch {
        return false;
    }
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

    hydrated = true;
    const config = await getConfig();
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
    const child = spawn(
        TTYD_BIN,
        [
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
        {
            cwd,
            detached: true,
            stdio: "ignore",
        }
    );
    child.unref();

    child.on("error", (err) => logger.error({ err, id, port }, "ttyd child error"));
    child.on("exit", (code, signal) => {
        logger.debug({ id, port, code, signal }, "ttyd child exited");
        registry.delete(id);
        void persistRegistry();
    });

    const session: TtydSession = {
        id,
        port,
        command,
        cwd,
        pid: child.pid ?? -1,
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

export async function killTtyd(id: string): Promise<boolean> {
    await hydrateRegistry();

    const tracked = registry.get(id);

    if (!tracked) {
        return false;
    }

    if (tracked.child) {
        tracked.child.kill("SIGTERM");
    } else {
        try {
            process.kill(tracked.session.pid, "SIGTERM");
        } catch (err) {
            logger.debug({ err, id }, "ttyd process already gone");
        }
    }

    if (tracked.session.tmuxSessionName) {
        killTmuxSession(tracked.session.tmuxSessionName);
    }

    registry.delete(id);
    await persistRegistry();

    return true;
}

export async function killAllTtyd(): Promise<void> {
    for (const { child, session } of registry.values()) {
        if (child) {
            child.kill("SIGTERM");
        } else {
            try {
                process.kill(session.pid, "SIGTERM");
            } catch (err) {
                logger.debug({ err, id: session.id }, "ttyd process already gone");
            }
        }

        if (session.tmuxSessionName) {
            killTmuxSession(session.tmuxSessionName);
        }
    }

    registry.clear();
    await persistRegistry();
}
