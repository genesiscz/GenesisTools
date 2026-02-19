import { createHash } from "crypto";
import { existsSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";

export const SERVERS_DIR = path.join(tmpdir(), ".mcp-tsc-servers");

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

export { wrapArray } from "@app/utils/array";
