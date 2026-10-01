import { closeSync, openSync, readSync } from "node:fs";
import { readTaskNotifications } from "@genesiscz/utils/ai/transcripts/file-scan";
import { listSubagents } from "@genesiscz/utils/ai/transcripts/subagents";
import { logger } from "@genesiscz/utils/logger";
import { readSessionTeam, unreadInbox } from "./team";
import { buildParent, type ParentRow } from "./tree";
import type { AgentParent } from "./types";
import type { WorkerAgent } from "./workers";

const HEAD_BYTES = 16 * 1024;

/** The first `timestamp` in a transcript's head: when the session started. */
export function startedAtOf(path: string): string | null {
    let fd: number | null = null;
    try {
        fd = openSync(path, "r");
        const buffer = Buffer.alloc(HEAD_BYTES);
        const read = readSync(fd, buffer, 0, HEAD_BYTES, 0);
        return /"timestamp":"([^"]+)"/.exec(buffer.subarray(0, read).toString("utf8"))?.[1] ?? null;
    } catch (error) {
        logger.debug({ error, path }, "[hub agents] unreadable parent head");
        return null;
    } finally {
        if (fd !== null) {
            closeSync(fd);
        }
    }
}

export function readParent(
    row: ParentRow,
    workers: WorkerAgent[],
    root: string,
    { now, promptChars }: { now: number; promptChars?: number }
): AgentParent {
    const { subagents } = listSubagents(
        { provider: "claude", source: "native", sessionId: row.sessionId, filePath: row.filePath },
        { now, scan: true, promptChars }
    );
    const team = readSessionTeam(row.sessionId, root);
    const unread = new Map<string, number>();
    if (team) {
        for (const agent of subagents) {
            if (agent.name && (agent.taskKind === "in_process_teammate" || agent.teamName)) {
                unread.set(agent.name, unreadInbox(root, team.name, agent.name).length);
            }
        }
    }

    // Only a parent with agents can have notifications about them; a parent's whole file is
    // scanned for them once, by bytes (`readTaskNotifications`).
    const notifications = subagents.length > 0 ? readTaskNotifications(row.filePath) : new Map();
    return buildParent(
        { row, startedAt: startedAtOf(row.filePath), subagents, notifications, team, unread, workers },
        now
    );
}
