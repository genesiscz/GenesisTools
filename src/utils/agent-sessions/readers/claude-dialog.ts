import { basename, dirname, join } from "node:path";
import { liveClaudeSessionIds } from "@genesiscz/utils/claude/peer-message";
import type { NativeSessionReader } from "../types";

export function claudeRegistryDirectory(transcriptPath: string): string | null {
    const projects = dirname(dirname(transcriptPath));
    return basename(projects) === "projects" ? join(dirname(projects), "sessions") : null;
}

/** Liveness from the registry belonging to this native transcript, or unknown when the owner cannot be established. */
export function claudeNativeSessionAlive(
    transcriptPath: string,
    sessionId: string,
    read: (directory: string) => Set<string> | null = liveClaudeSessionIds
): boolean | null {
    const directory = claudeRegistryDirectory(transcriptPath);
    if (!directory) {
        return null;
    }

    const live = read(directory);
    return live ? live.has(sessionId.toLowerCase()) : null;
}

export const claudeDialog: NativeSessionReader<"claude">["dialog"] = {
    eventLogPath: () => null,
    openPermission: () => null,
    sessionAlive: claudeNativeSessionAlive,
    registryDirectory: claudeRegistryDirectory,
};
