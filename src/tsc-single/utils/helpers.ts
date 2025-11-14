import { createHash } from "crypto";
import { existsSync, mkdirSync } from "fs";
import path from "path";
import { tmpdir } from "os";

export const SERVERS_DIR = path.join(tmpdir(), ".tsc-single-servers");

/**
 * Ensure the servers directory exists
 */
export function ensureServersDir(): void {
    if (!existsSync(SERVERS_DIR)) {
        mkdirSync(SERVERS_DIR, { recursive: true });
    }
}

/**
 * Get server info file path for a directory
 * Uses MD5 hash of the directory path for unique identification
 */
export function getServerInfoPath(cwd: string): string {
    const hash = createHash("md5").update(cwd).digest("hex").slice(0, 8);
    return path.join(SERVERS_DIR, `server-${hash}.json`);
}

/**
 * Wrap a value in an array if it isn't already an array
 */
export function wrapArray<T>(value: T | T[]): T[] {
    return Array.isArray(value) ? value : [value];
}
