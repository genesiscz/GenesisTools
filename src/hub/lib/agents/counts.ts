import { resolveTranscript } from "@genesiscz/utils/ai/transcripts/resolve";
import { listSubagents } from "@genesiscz/utils/ai/transcripts/subagents";
import { logger } from "@genesiscz/utils/logger";
import { readSessionTeam } from "./team";
import { agentStatus } from "./tree";
import type { AgentStatus } from "./types";

/** One running row's refresh: what changes while an agent writes. */
export interface AgentCount {
    id: string;
    toolCalls: number;
    lastAt: string;
    /**
     * The transcript's own view (`agentStatus` without the parent's task notifications): `running`,
     * `idle` (a teammate still in the team), `completed` or `killed`. When a row leaves `running`,
     * read the full tree once for a notification-driven `failed`.
     */
    status: AgentStatus;
    bytes: number;
}

export interface AgentCounts {
    generatedAt: string;
    agents: AgentCount[];
}

export interface AgentCountsOptions {
    /** The lead session: id, id prefix, or its transcript path. */
    session: string;
    /** Agent ids (`aE-sharedkit-4743…`, with or without `agent-`). */
    ids: string[];
    now?: number;
    teamsRoot?: string;
}

/**
 * The narrow refresh door for running rows: only these agents' transcripts are opened (head, tail
 * and the byte scan for tool calls). No session index, no parent listing, no workers, no parent
 * notification scan. An unknown id is left out of the answer.
 */
export async function agentCounts(options: AgentCountsOptions): Promise<AgentCounts> {
    const now = options.now ?? Date.now();
    const ids = options.ids.map((id) => id.replace(/^agent-/, "").replace(/\.jsonl$/, "")).filter(Boolean);
    const parent = await resolveTranscript(options.session, {}, "claude");
    const { subagents } = listSubagents(parent, { now, ids, scan: true });
    const team = subagents.some((agent) => agent.teamName || agent.taskKind === "in_process_teammate")
        ? readSessionTeam(parent.sessionId, options.teamsRoot)
        : null;
    const agents = subagents.map((agent) => ({
        id: agent.id,
        toolCalls: agent.toolCalls ?? 0,
        lastAt: agent.lastAt,
        status: agentStatus(agent, undefined, agent.name ? (team?.members.has(agent.name) ?? false) : false),
        bytes: agent.bytes,
    }));
    logger.debug({ session: parent.sessionId, asked: ids.length, found: agents.length }, "[hub agents] counts");
    return { generatedAt: new Date(now).toISOString(), agents };
}
