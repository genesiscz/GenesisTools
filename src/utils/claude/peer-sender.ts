import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveTranscript } from "@genesiscz/utils/ai/transcripts/resolve";
import {
    claudeSessionsDir,
    type PeerSender,
    type PeerSenderMode,
    parseRegistryEntry,
} from "@genesiscz/utils/claude/peer-message";
import { env } from "@genesiscz/utils/env";
import { readLastLines, readLinesSync } from "@genesiscz/utils/fs/read-lines";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

/**
 * Who sends a peer message from inside a Claude Code session. A Bash tool child inherits the session's id
 * (`CLAUDE_CODE_SESSION_ID`), its pid (`CLAUDE_PID`) and its own messaging socket (`CLAUDE_CODE_MESSAGING_SOCKET`).
 * No variable carries the permission mode, so it comes from the session's transcript. The messaging token in the
 * same environment is a credential for the parent's own socket and is never read here.
 */

const { log } = logger.scoped("claude-peer");

/**
 * The class Claude Code compares in `from-mode`: `bypassPermissions` is bypass, and `plan` is bypass only when the
 * session may bypass prompts, which a child process cannot read, so `plan` is unknown. Every other mode prompts.
 */
export function senderModeOf(permissionMode: string | null): PeerSenderMode | null {
    if (permissionMode === null || permissionMode === "plan") {
        return null;
    }

    return permissionMode === "bypassPermissions" ? "bypass" : "prompting";
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function permissionModeOfLine(line: string): string | null {
    if (!line.includes('"permission-mode"')) {
        return null;
    }

    let parsed: unknown;

    try {
        parsed = SafeJSON.parse(line, { strict: true });
    } catch (error) {
        log.debug({ error }, "unreadable permission-mode line");
        return null;
    }

    if (!isRecord(parsed) || parsed.type !== "permission-mode") {
        return null;
    }

    const mode = parsed.permissionMode;
    return typeof mode === "string" && mode !== "" ? mode : null;
}

/** How far from the end `readLastPermissionMode` looks before it streams the whole transcript. */
const MODE_WINDOWS = [256 * 1024, 8 * 1024 * 1024];

/**
 * The `permissionMode` of the last `{"type":"permission-mode"}` line of a Claude transcript, which is the mode the
 * session recorded last. Claude Code appends that line with the session metadata, so it can lag a mode switch made
 * a moment ago by one append. The end of the file is read first (the lines recur every few dozen KB in a live
 * session); only a transcript with none near its end is streamed in full, never held in memory whole.
 * Throws when the file cannot be read.
 */
export function readLastPermissionMode(
    transcriptPath: string,
    windows: readonly number[] = MODE_WINDOWS
): string | null {
    for (const maxBytes of windows) {
        const { lines, wholeFile } = readLastLines(transcriptPath, { maxBytes });

        for (let index = lines.length - 1; index >= 0; index--) {
            const mode = permissionModeOfLine(lines[index]);

            if (mode !== null) {
                return mode;
            }
        }

        if (wholeFile) {
            return null;
        }
    }

    let last: string | null = null;

    for (const line of readLinesSync(transcriptPath)) {
        last = permissionModeOfLine(line) ?? last;
    }

    return last;
}

async function claudeTranscriptOf(sessionId: string): Promise<string | null> {
    try {
        const resolved = await resolveTranscript(sessionId, {}, "claude");
        return resolved.source === "native" && resolved.sessionId === sessionId ? resolved.filePath : null;
    } catch (error) {
        log.debug({ error, sessionId }, "no transcript for the sending session");
        return null;
    }
}

function registryName(pid: string, dir: string): string | null {
    if (!/^\d+$/.test(pid)) {
        return null;
    }

    const file = join(dir, `${pid}.json`);

    try {
        return parseRegistryEntry(readFileSync(file, "utf8"), file)?.name ?? null;
    } catch (error) {
        log.debug({ error, file }, "no registry entry for the sending session");
        return null;
    }
}

export interface PeerSenderSources {
    /** One environment variable; the process environment by default. */
    variable?: (name: string) => string | undefined;
    /** The Claude session registry (`~/.claude/sessions`). */
    sessionsDir?: string;
    /** The transcript path of a Claude session id, or null; the shared transcript resolver by default. */
    transcriptOf?: (sessionId: string) => Promise<string | null>;
}

/**
 * The Claude Code session this process runs under, as the sender of a peer message: its id, its own socket, its
 * registry name and its permission class. Null outside a Claude Code session, or in one without a messaging socket:
 * a script cannot attest anything, so its messages stay plain.
 */
export async function currentClaudeSender(sources: PeerSenderSources = {}): Promise<PeerSender | null> {
    const variable = sources.variable ?? ((name: string) => env.getTrimmed(name));
    const sessionId = variable("CLAUDE_CODE_SESSION_ID");
    const socketPath = variable("CLAUDE_CODE_MESSAGING_SOCKET");

    if (!sessionId || !socketPath) {
        log.debug({ sessionId: sessionId ?? null }, "not inside a Claude Code session with a messaging socket");
        return null;
    }

    const pid = variable("CLAUDE_PID");
    const name = pid ? registryName(pid, sources.sessionsDir ?? claudeSessionsDir()) : null;
    const transcript = await (sources.transcriptOf ?? claudeTranscriptOf)(sessionId);
    let permissionMode: string | null = null;

    if (transcript) {
        try {
            permissionMode = readLastPermissionMode(transcript);
        } catch (error) {
            log.debug({ error, transcript }, "the sending session's transcript is unreadable");
        }
    }

    const mode = senderModeOf(permissionMode);
    log.debug({ sessionId, pid, name, permissionMode, mode }, "peer message sender");
    return { sessionId, socketPath, name, mode };
}
