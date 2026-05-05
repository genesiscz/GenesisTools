import { homedir } from "node:os";
import { resolve, sep } from "node:path";

/**
 * Single source of truth for where session JSONL files live on disk.
 * All readers (dashboard-server, http-server, sse-broadcaster, file-tailer)
 * resolve session paths via this constant — keep them in sync by importing
 * from here instead of re-deriving the path.
 */
export const SESSIONS_DIR = resolve(homedir(), ".genesis-tools", "debugging-master", "sessions");

/**
 * Resolve the JSONL file path for a session by name. Defense-in-depth:
 * rejects any name that resolves outside `SESSIONS_DIR` so a future caller
 * that forgets to validate `sessionName` can't escape the sessions tree.
 */
export function sessionFilePath(sessionName: string): string {
    const candidate = resolve(SESSIONS_DIR, `${sessionName}.jsonl`);
    if (!candidate.startsWith(`${SESSIONS_DIR}${sep}`)) {
        throw new Error(`Invalid session name: ${sessionName}`);
    }

    return candidate;
}
