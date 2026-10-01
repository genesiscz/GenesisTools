import { statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
    type AgentSessionRow,
    listAgentSessionRows,
    POLLED_LISTING_REUSE_MS,
} from "@app/ai/lib/sessions/agent-session-rows";
import { getSessionListing } from "@app/claude/lib/history/search";
import { teamsRoot } from "@app/claude/lib/teams/discover";
import type { SessionMetadataRecord } from "@genesiscz/utils/agent-sessions/cache-types";
import { resolveTranscript } from "@genesiscz/utils/ai/transcripts/resolve";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { readParent } from "./parent";
import { type ParentRow, sortNodes, sortParents, withoutFullPrompts } from "./tree";
import { type AgentNode, type AgentsTree, DEFAULT_AGENTS_LIMIT, DEFAULT_AGENTS_SINCE_HOURS } from "./types";

export { DEFAULT_AGENTS_LIMIT, DEFAULT_AGENTS_SINCE_HOURS } from "./types";

import { listWorkers, type WorkerAgent } from "./workers";

export type { AgentMail, AgentNode, AgentParent, AgentsTree } from "./types";

const prof = profiler.scope("hub-agents");

export interface HubAgentsOptions {
    /** The window in hours. Default 24. */
    hours?: number;
    /** At most this many parents. Default 50. */
    limit?: number;
    /** One parent session (id or id prefix), whatever its age. */
    session?: string;
    now?: number;
    /** Override the teams root (tests). */
    teamsRoot?: string;
    /** Spawn prompt characters read per agent; the list keeps listSubagents' default. */
    promptChars?: number;
}

function parentRow(row: AgentSessionRow): ParentRow {
    return {
        sessionId: row.sessionId,
        title: row.title,
        project: row.project,
        cwd: row.cwd,
        filePath: row.filePath,
        model: row.model,
        account: row.account,
        mtime: row.mtime,
    };
}

/** A parent the listing did not return (older than the window): only what its file says. */
async function parentById(id: string, rows: AgentSessionRow[], now: number): Promise<ParentRow | null> {
    const listed = rows.find((row) => row.sessionId === id || row.sessionId.startsWith(id));
    if (listed) {
        return parentRow(listed);
    }

    try {
        const resolved = await resolveTranscript(id, {}, "claude");
        const mtime = Bun.file(resolved.filePath).lastModified;
        // The window reaching back to that session, so the index row (title, project, account)
        // is read rather than guessed. Nothing older than it is read.
        const hours = (now - mtime) / 3_600_000 + 0.01;
        const rows = await listAgentSessionRows({
            providers: ["claude"],
            hours,
            maxDiscoveryAgeMs: POLLED_LISTING_REUSE_MS,
        });
        const row = rows.find((candidate) => candidate.sessionId === resolved.sessionId);
        return row
            ? parentRow(row)
            : {
                  sessionId: resolved.sessionId,
                  title: null,
                  project: null,
                  cwd: "",
                  filePath: resolved.filePath,
                  model: null,
                  account: null,
                  mtime,
              };
    } catch (error) {
        logger.debug({ error, id }, "[hub agents] parent session not found");
        return null;
    }
}

/** Sub-agent transcripts the session index saw written at or after `since` (the window is in the SQL). */
async function recentAgentRecords(since: number): Promise<SessionMetadataRecord[]> {
    const listing = await getSessionListing({
        subagentsOnly: true,
        mtimeFrom: since,
        maxDiscoveryAgeMs: POLLED_LISTING_REUSE_MS,
    });
    return listing.sessions;
}

/**
 * Parents whose own file is older than the window but one of whose Claude agents wrote inside it.
 * Read from the session index's sub-agent rows with the window in the query (`mtimeFrom`), not by
 * walking old sessions. The index row of a sub-agent names its lead session; that lead gets a row
 * from its file alone (title unknown), since the listing did not return it.
 */
export async function parentsOfRecentAgents(
    since: number,
    listed: Set<string>,
    listAgents: (since: number) => Promise<SessionMetadataRecord[]> = recentAgentRecords
): Promise<ParentRow[]> {
    let children: SessionMetadataRecord[];
    try {
        children = (await listAgents(since)).filter((child) => child.mtime >= since);
    } catch (error) {
        logger.warn({ error }, "[hub agents] sub-agent listing unavailable; parents come from their own mtime only");
        return [];
    }

    const extra = new Map<string, ParentRow>();
    for (const child of children) {
        // `<project>/<lead id>/subagents/agent-<id>.jsonl`
        const leadDir = dirname(dirname(child.filePath));
        const leadId = basename(leadDir);
        if (listed.has(leadId) || extra.has(leadId) || basename(dirname(child.filePath)) !== "subagents") {
            continue;
        }

        const filePath = join(dirname(leadDir), `${leadId}.jsonl`);
        let mtime: number;
        try {
            mtime = statSync(filePath).mtimeMs;
        } catch (error) {
            logger.debug({ error, filePath }, "[hub agents] a recent agent's lead transcript is gone");
            continue;
        }

        extra.set(leadId, {
            sessionId: leadId,
            title: null,
            project: child.project,
            cwd: child.cwd ?? "",
            filePath,
            model: null,
            account: null,
            mtime,
        });
    }

    logger.debug({ children: children.length, extraParents: extra.size }, "[hub agents] parents of recent agents");
    return [...extra.values()];
}

/** The full tree: every node carries its whole spawn prompt (the list strips it, `hubAgent` keeps it). */
async function buildTree(options: HubAgentsOptions): Promise<AgentsTree> {
    const now = options.now ?? Date.now();
    const hours = options.hours ?? DEFAULT_AGENTS_SINCE_HOURS;
    const limit = options.limit ?? DEFAULT_AGENTS_LIMIT;
    const root = options.teamsRoot ?? teamsRoot();
    const since = now - hours * 3_600_000;

    const [rows, workers] = await Promise.all([
        prof.measureAsync("parents", () =>
            options.session
                ? Promise.resolve([])
                : listAgentSessionRows({
                      providers: ["claude"],
                      hours,
                      limit,
                      maxDiscoveryAgeMs: POLLED_LISTING_REUSE_MS,
                  })
        ),
        prof.measureAsync("workers", () => listWorkers({ now, since, promptChars: options.promptChars })),
    ]);

    let parentRows: ParentRow[];
    if (options.session) {
        const one = await parentById(options.session, rows, now);
        parentRows = one ? [one] : [];
    } else {
        parentRows = rows.map(parentRow);
        const listed = new Set(parentRows.map((row) => row.sessionId));
        // A parent is in the window when any of its agents is, like a worker's rendezvous session.
        const byChild = await prof.measureAsync("agent-parents", () => parentsOfRecentAgents(since, listed));
        for (const row of byChild) {
            parentRows.push(row);
            listed.add(row.sessionId);
        }

        const waiting = new Set(
            workers
                .filter((worker) => worker.node.status === "running" && worker.rendezvousSession)
                .map((worker) => worker.rendezvousSession as string)
                .filter((id) => !listed.has(id))
        );
        for (const id of waiting) {
            const extra = await parentById(id, rows, now);
            if (extra) {
                parentRows.push(extra);
            }
        }
    }

    const bySession = new Map<string, WorkerAgent[]>();
    for (const worker of workers) {
        if (worker.rendezvousSession) {
            bySession.set(worker.rendezvousSession, [...(bySession.get(worker.rendezvousSession) ?? []), worker]);
        }
    }

    const parents = sortParents(
        prof.measure("tree", () =>
            parentRows.map((row) =>
                readParent(row, bySession.get(row.sessionId) ?? [], root, { now, promptChars: options.promptChars })
            )
        )
    ).slice(0, limit);
    // From the parents returned, after the limit: a worker whose parent was cut is an orphan, never dropped.
    const attached = new Set(parents.map((parent) => parent.sessionId));
    const orphans = options.session
        ? []
        : workers
              .filter((worker) => !worker.rendezvousSession || !attached.has(worker.rendezvousSession))
              .map((worker) => worker.node);

    logger.debug(
        { parents: parents.length, orphans: orphans.length, hours, session: options.session ?? null },
        "[hub agents] tree built"
    );
    return {
        generatedAt: new Date(now).toISOString(),
        parents,
        orphans: sortNodes(orphans),
    };
}

/**
 * Every Claude session in the window with its agents: sub-agents and teammates from its
 * `subagents/` folder, codex and grok workers from their rendezvous session. A session is in the
 * window when it or any of its agents wrote inside it. A worker whose rendezvous session is not
 * listed is an orphan; a RUNNING one pulls its session in whatever that session's age.
 *
 * The list carries `spawnPromptPreview` only (`spawnPrompt` is null); `hubAgent` returns one
 * agent with its whole prompt.
 */
export async function hubAgents(options: HubAgentsOptions = {}): Promise<AgentsTree> {
    const tree = await buildTree(options);
    return {
        ...tree,
        parents: tree.parents.map((parent) => ({ ...parent, children: withoutFullPrompts(parent.children) })),
        orphans: withoutFullPrompts(tree.orphans),
    };
}

export interface AgentDetail {
    generatedAt: string;
    /** The lead session the agent belongs to; null for an orphan worker. */
    sessionId: string | null;
    /** The agent with its whole `spawnPrompt`; its children carry previews only. */
    agent: AgentNode;
}

function findNode(nodes: AgentNode[], id: string): AgentNode | undefined {
    for (const node of nodes) {
        if (node.id === id || node.id === id.replace(/^agent-/, "") || node.name === id) {
            return node;
        }

        const inner = findNode(node.children, id);
        if (inner) {
            return inner;
        }
    }

    return undefined;
}

/**
 * One agent of a parent (`session`), or of any listed parent when `session` is absent, with its
 * whole spawn prompt. Null when no such agent is found.
 */
export async function hubAgent(options: HubAgentsOptions & { agent: string }): Promise<AgentDetail | null> {
    const tree = await buildTree({ ...options, promptChars: Number.POSITIVE_INFINITY });
    for (const parent of tree.parents) {
        const node = findNode(parent.children, options.agent);
        if (node) {
            return {
                generatedAt: tree.generatedAt,
                sessionId: parent.sessionId,
                agent: { ...node, children: withoutFullPrompts(node.children) },
            };
        }
    }

    const orphan = findNode(tree.orphans, options.agent);
    return orphan ? { generatedAt: tree.generatedAt, sessionId: null, agent: orphan } : null;
}

export { agentMail } from "./mail";
