/**
 * The pending-login record: which process is holding an OAuth login open for a server,
 * and the URL the user has to visit.
 *
 * Written by `auth login` itself, so every login is visible here, whether a person typed
 * the command or the gateway spawned it. Read by the gateway before it starts a login,
 * which is what stops a RESTARTED gateway from opening a second browser window while the
 * first login is still waiting for its callback in a process that outlived the restart.
 *
 * A record whose pid is dead is stale, never authoritative: a login killed by SIGKILL
 * gets no chance to clear its own file.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

export interface PendingLogin {
    server: string;
    pid: number;
    url?: string;
    startedAt: number;
}

export function pendingLoginDir(): string {
    return join(env.tools.getHome(), ".genesis-tools", "mcp-manager", "logins");
}

export function pendingLoginPath(server: string): string {
    return join(pendingLoginDir(), `${encodeURIComponent(server)}.json`);
}

export function pidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);

        return true;
    } catch (error) {
        // EPERM means the process exists but belongs to someone else. A login this user
        // did not start cannot be one of ours, so it is not "pending" for our purposes.
        logger.debug({ pid, error }, "pending-login pid is not alive");

        return false;
    }
}

export function writePendingLogin(state: PendingLogin): void {
    mkdirSync(pendingLoginDir(), { recursive: true });
    writeFileSync(pendingLoginPath(state.server), SafeJSON.stringify(state, null, 2), { mode: 0o600 });
}

export function clearPendingLogin(server: string): void {
    const path = pendingLoginPath(server);

    if (existsSync(path)) {
        unlinkSync(path);
    }
}

/** The live record, or undefined. A stale record (dead pid, unreadable file) is removed. */
export function readPendingLogin(server: string): PendingLogin | undefined {
    const path = pendingLoginPath(server);

    if (!existsSync(path)) {
        return undefined;
    }

    let parsed: unknown;

    try {
        parsed = SafeJSON.parse(readFileSync(path, "utf8"), { strict: true });
    } catch (error) {
        logger.warn({ path, error }, "pending-login file is unreadable; removing it");
        clearPendingLogin(server);

        return undefined;
    }

    if (!isPendingLogin(parsed) || parsed.server !== server) {
        logger.warn({ path }, "pending-login file has the wrong shape; removing it");
        clearPendingLogin(server);

        return undefined;
    }

    if (!pidAlive(parsed.pid)) {
        logger.info({ server, pid: parsed.pid }, "pending-login process is gone; removing its record");
        clearPendingLogin(server);

        return undefined;
    }

    return parsed;
}

function isPendingLogin(value: unknown): value is PendingLogin {
    if (!value || typeof value !== "object") {
        return false;
    }

    const record = value as Record<string, unknown>;

    return (
        typeof record.server === "string" &&
        typeof record.pid === "number" &&
        typeof record.startedAt === "number" &&
        (record.url === undefined || typeof record.url === "string")
    );
}
