/**
 * The pending-login record: which process is holding an OAuth login open for a server,
 * and the URL the user has to visit.
 *
 * Written by the gateway parent at spawn (so a restart during child startup cannot
 * open a second window) and by `auth login` itself. Identity is a real PidRecord:
 * command line plus process start time, classified with inspectPidFile. Readers
 * never delete; sweep stale files through {@link clearStalePendingLogin}.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { buildPidRecord, inspectPidFile, type PidRecord } from "@genesiscz/utils/process/pidfile";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";
import { mcpManagerDir } from "../auth/paths.ts";

export interface PendingLogin {
    server: string;
    url?: string;
    identity: PidRecord;
}

export function pendingLoginDir(): string {
    return join(mcpManagerDir(), "logins");
}

export function pendingLoginPath(server: string): string {
    return join(pendingLoginDir(), `${encodeURIComponent(server)}.json`);
}

export function writePendingLogin(state: { server: string; url?: string; pid?: number }): void {
    mkdirSync(pendingLoginDir(), { recursive: true, mode: 0o700 });
    const identity = buildPidRecord(state.pid);
    const record = {
        server: state.server,
        ...(state.url === undefined ? {} : { url: state.url }),
        ...identity,
    };
    atomicWriteFileSync(pendingLoginPath(state.server), `${SafeJSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

export function clearPendingLogin(server: string): void {
    const path = pendingLoginPath(server);

    if (existsSync(path)) {
        unlinkSync(path);
    }
}

/**
 * Remove a pending-login file whose pid is gone, foreign, or whose payload is unusable.
 * Named so a `read*` cannot be mistaken for a diagnostic that mutates durable state.
 */
export function clearStalePendingLogin(server: string): boolean {
    const path = pendingLoginPath(server);

    if (!existsSync(path)) {
        return false;
    }

    const state = inspectPidFile(path);

    if (state.status === "live" || state.status === "unverified") {
        const payload = readPendingPayload(path);

        if (payload?.server === server) {
            return false;
        }
    }

    logger.info(
        { server, status: state.status, pid: "pid" in state ? state.pid : undefined },
        "pending-login record is stale; removing it"
    );
    clearPendingLogin(server);

    return true;
}

/** The live record, or undefined. Does not delete; call {@link clearStalePendingLogin} to sweep. */
export function readPendingLogin(server: string): PendingLogin | undefined {
    const path = pendingLoginPath(server);
    const state = inspectPidFile(path);

    if (state.status !== "live" && state.status !== "unverified") {
        return undefined;
    }

    const payload = readPendingPayload(path);

    if (!payload || payload.server !== server) {
        return undefined;
    }

    return {
        server: payload.server,
        url: payload.url,
        identity: state.record,
    };
}

function readPendingPayload(path: string): { server: string; url?: string } | undefined {
    try {
        const parsed: unknown = SafeJSON.parse(readFileSync(path, "utf8"), { strict: true });

        if (!parsed || typeof parsed !== "object") {
            return undefined;
        }

        const record = parsed as Record<string, unknown>;

        if (typeof record.server !== "string") {
            return undefined;
        }

        if (record.url !== undefined && typeof record.url !== "string") {
            return undefined;
        }

        return { server: record.server, url: record.url };
    } catch (error) {
        logger.debug({ path, error }, "pending-login file is unreadable");

        return undefined;
    }
}
