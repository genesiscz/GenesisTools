import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { withFileLock } from "@genesiscz/utils/storage";
import { refreshLockPath } from "./paths.ts";

export async function withRefreshLock<T>(server: string, fn: () => Promise<T>): Promise<T> {
    const lockPath = refreshLockPath(server);
    mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });

    return withFileLock(lockPath, fn, 15_000);
}
