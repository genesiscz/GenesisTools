import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Single source of truth for where session JSONL files live on disk.
 * All readers (dashboard-server, http-server, sse-broadcaster, file-tailer)
 * resolve session paths via this constant — keep them in sync by importing
 * from here instead of re-deriving the path.
 */
export const SESSIONS_DIR = join(homedir(), ".genesis-tools", "debugging-master", "sessions");

/** Resolve the JSONL file path for a session by name. */
export function sessionFilePath(sessionName: string): string {
    return join(SESSIONS_DIR, `${sessionName}.jsonl`);
}
