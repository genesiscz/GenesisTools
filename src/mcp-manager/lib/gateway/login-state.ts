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
import {
    buildPidRecord,
    classifyPidRecord,
    inspectPidFile,
    type PidRecord,
    parsePidRecord,
} from "@genesiscz/utils/process/pidfile";
import { withFileLock } from "@genesiscz/utils/storage/file-lock";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";
import { mcpManagerDir } from "../auth/paths.ts";

export interface PendingLogin {
    server: string;
    url?: string;
    userCode?: string;
    identity: PidRecord;
}

export interface PendingLoginWrite {
    server: string;
    url?: string;
    userCode?: string;
    pid?: number;
}

interface PendingPayload {
    server: string;
    url?: string;
    userCode?: string;
}

export function pendingLoginDir(): string {
    return join(mcpManagerDir(), "logins");
}

export function pendingLoginPath(server: string): string {
    return join(pendingLoginDir(), `${encodeURIComponent(server)}.json`);
}

export async function writePendingLogin(state: PendingLoginWrite): Promise<void> {
    mkdirSync(pendingLoginDir(), { recursive: true, mode: 0o700 });
    const path = pendingLoginPath(state.server);

    // Parent spawn and the detached child both write this file. The same-pid URL
    // merge is only correct if that read-modify-write cannot interleave.
    await withFileLock(`${path}.lock`, async () => {
        const identity = buildPidRecord(state.pid);
        let url = state.url;
        let userCode = state.userCode;

        if (url === undefined || userCode === undefined) {
            const existing = readPendingFile(path);

            if (existing?.identity.pid === identity.pid) {
                url ??= existing.url;
                userCode ??= existing.userCode;
            }
        }

        const record = {
            server: state.server,
            ...(url === undefined ? {} : { url }),
            ...(userCode === undefined ? {} : { userCode }),
            ...identity,
        };
        atomicWriteFileSync(path, `${SafeJSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    });
}

/**
 * Remove the pending-login file. When `ownerPid` is set, leave a record owned by
 * a different process — a completing login must not delete a replacement.
 */
export function clearPendingLogin(server: string, ownerPid?: number): void {
    const path = pendingLoginPath(server);
    const snapshot = readFileIfPresent(path);

    if (snapshot === undefined) {
        return;
    }

    if (ownerPid !== undefined) {
        const identity = parsePidRecord(snapshot);

        if (!identity || identity.pid !== ownerPid) {
            logger.info(
                { server, ownerPid, pid: identity?.pid },
                "pending-login belongs to another process; not clearing"
            );

            return;
        }
    }

    const current = readFileIfPresent(path);

    if (current !== snapshot) {
        logger.info({ server, ownerPid }, "pending-login was replaced; not clearing");

        return;
    }

    unlinkSync(path);
}

/**
 * Remove a pending-login file whose pid is gone, foreign, or whose payload is unusable.
 * Named so a `read*` cannot be mistaken for a diagnostic that mutates durable state.
 * Deletes only if the bytes classified as stale are still the bytes on disk.
 */
export function clearStalePendingLogin(server: string): boolean {
    const path = pendingLoginPath(server);
    const snapshot = readFileIfPresent(path);

    if (snapshot === undefined) {
        return false;
    }

    if (isLivePending(snapshot, server)) {
        return false;
    }

    logger.info({ server }, "pending-login record is stale; removing it");

    const current = readFileIfPresent(path);

    if (current === undefined) {
        return false;
    }

    if (current !== snapshot) {
        logger.info({ server }, "pending-login was replaced; not removing");

        return false;
    }

    unlinkSync(path);

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
        userCode: payload.userCode,
        identity: state.record,
    };
}

function isLivePending(snapshot: string, server: string): boolean {
    const record = parsePidRecord(snapshot);

    if (!record) {
        return false;
    }

    const identity = classifyPidRecord(record);

    if (identity.status !== "live" && identity.status !== "unverified") {
        return false;
    }

    const payload = parsePendingPayload(snapshot);

    return payload?.server === server;
}

function readPendingFile(path: string): (PendingPayload & { identity: PidRecord }) | undefined {
    const raw = readFileIfPresent(path);

    if (raw === undefined) {
        return undefined;
    }

    const identity = parsePidRecord(raw);
    const payload = parsePendingPayload(raw);

    if (!identity || !payload) {
        return undefined;
    }

    return { ...payload, identity };
}

function readPendingPayload(path: string): PendingPayload | undefined {
    const raw = readFileIfPresent(path);

    if (raw === undefined) {
        return undefined;
    }

    return parsePendingPayload(raw);
}

function parsePendingPayload(raw: string): PendingPayload | undefined {
    try {
        const parsed: unknown = SafeJSON.parse(raw, { strict: true });

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

        if (record.userCode !== undefined && typeof record.userCode !== "string") {
            return undefined;
        }

        return { server: record.server, url: record.url, userCode: record.userCode };
    } catch (error) {
        logger.debug({ error }, "pending-login payload is unreadable");

        return undefined;
    }
}

function readFileIfPresent(path: string): string | undefined {
    if (!existsSync(path)) {
        return undefined;
    }

    try {
        return readFileSync(path, "utf8");
    } catch (error) {
        logger.debug({ path, error }, "pending-login file is unreadable");

        return undefined;
    }
}
