import { basename, dirname, join } from "node:path";
import { liveClaudeSessionIds } from "@genesiscz/utils/claude/peer-message";
import type { NativeSessionReader } from "../types";

/** Liveness from the registry belonging to this native transcript, or unknown when the owner cannot be established. */
export function claudeNativeSessionAlive(
    transcriptPath: string,
    sessionId: string,
    read: (directory: string) => Set<string> | null = liveClaudeSessionIds
): boolean | null {
    const projects = dirname(dirname(transcriptPath));
    if (basename(projects) !== "projects") {
        return null;
    }

    const live = read(join(dirname(projects), "sessions"));
    return live ? live.has(sessionId.toLowerCase()) : null;
}

export const claudeDialog: NativeSessionReader<"claude">["dialog"] = {
    eventLogPath: () => null,
    openPermission: () => null,
    sessionAlive: claudeNativeSessionAlive,
};
