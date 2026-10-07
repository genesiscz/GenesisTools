import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { NETWORKED_LOCK_WAIT_MS, withFileLock } from "@genesiscz/utils/storage/file-lock";
import { refreshLockPath } from "./paths.ts";

/**
 * A refresh holds this lock across its credential requests, each bounded by
 * MCP_CREDENTIAL_TIMEOUT_MS. Waiters (logout, a second refresh) therefore get the
 * networked budget: an equal 15 s wait expired just as the holder finished.
 */
export const CREDENTIALS_LOCK_WAIT_MS = NETWORKED_LOCK_WAIT_MS;

export async function withServerCredentialsLock<T>(server: string, fn: () => Promise<T>): Promise<T> {
    const lockPath = refreshLockPath(server);
    mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });

    return withFileLock(lockPath, fn, CREDENTIALS_LOCK_WAIT_MS);
}

export const withRefreshLock = withServerCredentialsLock;
