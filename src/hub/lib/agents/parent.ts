import { readTaskNotifications } from "@genesiscz/utils/ai/transcripts/file-scan";
import { readHead } from "@genesiscz/utils/ai/transcripts/native-scan";
import { listSubagents } from "@genesiscz/utils/ai/transcripts/subagents";
import { logger } from "@genesiscz/utils/logger";
import { readSessionTeam, unreadInbox } from "./team";
import { buildParent, type ParentRow } from "./tree";
import type { AgentNode, AgentParent } from "./types";
import type { WorkerAgent } from "./workers";

const HEAD_BYTES = 16 * 1024;

/** The first `timestamp` in a transcript's head (a `.jsonl.zst` rollout's decompressed head): when the session started. */
export function startedAtOf(path: string): string | null {
    try {
        return /"timestamp":"([^"]+)"/.exec(readHead(path, HEAD_BYTES).toString("utf8"))?.[1] ?? null;
    } catch (error) {
        logger.debug({ error, path }, "[hub agents] unreadable parent head");
        return null;
    }
}

/** What a harness's parent builder (`parents/<harness id>.ts`) gets besides the row: one tree build's shared reads. */
export interface ParentContext {
    now: number;
    /** The teams root the teammates are read under. */
    root: string;
    promptChars?: number;
    /** The `tools <agent>` workers that report to a session. */
    workersOf(sessionId: string): WorkerAgent[];
    /** The Codex sub-agents a session spawned (its rollouts' agent records). */
    codexAgentsOf(sessionId: string): AgentNode[];
}

/** How a harness's session becomes a parent of the agents tree: the export `parents/<harness id>.ts` holds. */
export type ParentBuilder = (row: ParentRow, context: ParentContext) => AgentParent;

/** The parent of a session read from its transcript and its workers (Claude, and Grok with no sub-agents on disk). */
export const transcriptParent: ParentBuilder = (row, context) =>
    readParent(row, context.workersOf(row.sessionId), context.root, {
        now: context.now,
        promptChars: context.promptChars,
    });

export function readParent(
    row: ParentRow,
    workers: WorkerAgent[],
    root: string,
    { now, promptChars }: { now: number; promptChars?: number }
): AgentParent {
    const { subagents } = listSubagents(
        // Sub-agents on disk are Claude's (`SUBAGENTS_ON_DISK` in the transcript facts); another harness lists none.
        { provider: row.provider ?? "claude", source: "native", sessionId: row.sessionId, filePath: row.filePath },
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
