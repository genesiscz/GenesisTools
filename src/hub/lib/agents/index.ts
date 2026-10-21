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
import { resolveTranscripts } from "@genesiscz/utils/ai/transcripts/resolve";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { openAgentSessionIds } from "../procs/sources";
import { attachCodexAgents, buildCodexParent, type CodexAgentRecord, recentCodexAgentRecords } from "./codex-agents";
import { readParent, startedAtOf } from "./parent";
import { type ParentRow, sortNodes, sortParents, withoutFullPrompts } from "./tree";
import { type AgentNode, type AgentsTree, DEFAULT_AGENTS_LIMIT, DEFAULT_AGENTS_SINCE_HOURS } from "./types";

export { DEFAULT_AGENTS_LIMIT, DEFAULT_AGENTS_SINCE_HOURS } from "./types";

import { listWorkers, type WorkerAgent } from "./workers";

export type { AgentMail, AgentNode, AgentParent, AgentsTree } from "./types";

const prof = profiler.scope("hub-agents");

export interface HubAgentsOptions {
    /** False for diagnostics; intentional background refreshes may update the shared index and memo. */
    refresh?: boolean;
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
    /** Session ids a live agent process holds (tests pass their own; the default reads the process table). */
    openSessions?: () => Promise<Set<string>>;
}

/** The process table changes slowly next to the hub's refresh bursts, so a burst shares one read. */
const OPEN_SESSIONS_REUSE_MS = 3_000;
let openSessionsMemo: { at: number; ids: Set<string> } | undefined;

async function recentOpenSessionIds(): Promise<Set<string>> {
    const now = Date.now();

    if (openSessionsMemo && now - openSessionsMemo.at < OPEN_SESSIONS_REUSE_MS) {
        return openSessionsMemo.ids;
    }

    const ids = await openAgentSessionIds();
    openSessionsMemo = { at: now, ids };

    return ids;
}

/** A failed process listing leaves every parent to its transcript clock: nothing is marked open. */
async function readOpenSessions(options: HubAgentsOptions): Promise<Set<string>> {
    try {
        return await (options.openSessions ?? recentOpenSessionIds)();
    } catch (error) {
        logger.warn({ error }, "[hub agents] the process list is unavailable; no session is marked open");
        return new Set();
    }
}

/**
 * The file's own mtime when it is newer than the index row's. The session index can lag a large transcript that is
 * being written by many minutes: on 2026-10-07 a running 128 MB session showed "18m ago" and not live while its
 * file had changed seconds before. One stat per parent, and a missing file keeps the row's value.
 */
export function freshMtime(row: Pick<AgentSessionRow, "filePath" | "mtime">): number {
    try {
        const onDisk = statSync(row.filePath).mtimeMs;
        return Math.max(row.mtime, onDisk);
    } catch (error) {
        logger.debug(
            { error, filePath: row.filePath },
            "[hub agents] parent file not readable; keeping the index mtime"
        );
        return row.mtime;
    }
}

function parentRow(row: AgentSessionRow): ParentRow {
    return {
        provider: row.provider === "codex" ? "codex" : "claude",
        sessionId: row.sessionId,
        title: row.title,
        project: row.project,
        cwd: row.cwd,
        filePath: row.filePath,
        model: row.model,
        account: row.account,
        mtime: freshMtime(row),
    };
}

/**
 * A parent that no transcript backs (deleted, or on another machine) stays missing. The widget roster asks again
 * every few seconds, and on 2026-10-21 that searched both providers 21,000 times for the same few ids.
 */
const PARENT_MISS_REUSE_MS = 10 * 60_000;
const parentMisses = new Map<string, number>();

/** Missing parents share folder reads and one metadata listing, bounded to their transcript paths. */
async function parentsByIds({
    ids,
    rows,
    refresh,
}: {
    ids: Iterable<string>;
    rows: AgentSessionRow[];
    refresh?: boolean;
}): Promise<Map<string, ParentRow>> {
    const parents = new Map<string, ParentRow>();
    const missing = new Set<string>();
    for (const id of ids) {
        const listed = rows.find((row) => row.sessionId === id || row.sessionId.startsWith(id));
        if (listed) {
            parents.set(id, parentRow(listed));
        } else {
            missing.add(id);
        }
    }

    const now = Date.now();
    for (const id of missing) {
        const missedAt = parentMisses.get(id);

        if (missedAt !== undefined && now - missedAt < PARENT_MISS_REUSE_MS) {
            missing.delete(id);
        }
    }

    const resolved = new Map<string, ParentRow>();
    for (const provider of ["claude", "codex"] as const) {
        if (missing.size === 0) {
            break;
        }

        const transcripts = await resolveTranscripts([...missing], {}, provider);
        for (const [id, transcript] of transcripts) {
            if (transcript instanceof Error) {
                continue;
            }

            resolved.set(id, {
                provider,
                sessionId: transcript.sessionId,
                filePath: transcript.filePath,
                title: null,
                project: null,
                cwd: "",
                model: null,
                account: null,
                mtime: Bun.file(transcript.filePath).lastModified,
            });
            missing.delete(id);
        }
    }

    for (const id of missing) {
        logger.debug({ id }, "[hub agents] parent session not found");
        parentMisses.set(id, now);
    }

    if (resolved.size > 0) {
        const candidates = [...resolved.values()];
        const metadata = await listAgentSessionRows({
            providers: [...new Set(candidates.map((row) => row.provider ?? "claude"))],
            filePaths: [...new Set(candidates.map((row) => row.filePath))],
            refresh,
            maxDiscoveryAgeMs: POLLED_LISTING_REUSE_MS,
        });
        for (const [id, fallback] of resolved) {
            const row = metadata.find(
                (row) => row.sessionId === fallback.sessionId && row.provider === fallback.provider
            );
            parents.set(id, row ? parentRow(row) : fallback);
        }
    }

    return parents;
}

async function parentById(options: {
    id: string;
    rows: AgentSessionRow[];
    now: number;
    refresh?: boolean;
}): Promise<ParentRow | null> {
    return (
        (await parentsByIds({ ids: [options.id], rows: options.rows, refresh: options.refresh })).get(options.id) ??
        null
    );
}

/** Sub-agent transcripts the session index saw written at or after `since` (the window is in the SQL). */
async function recentAgentRecords({
    since,
    refresh,
}: {
    since: number;
    refresh?: boolean;
}): Promise<SessionMetadataRecord[]> {
    const listing = await getSessionListing({
        subagentsOnly: true,
        refresh,
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
    listAgents: (since: number) => Promise<SessionMetadataRecord[]> = (since) => recentAgentRecords({ since })
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

/** How far back a one-session lookup reaches for that session's Codex sub-agents. */
const SESSION_AGENTS_LOOKBACK_MS = 14 * 24 * 3_600_000;

/** Codex sub-agents from the session index; an index that cannot answer leaves the Codex rows without any. */
async function codexAgentRecords({
    since,
    refresh,
}: {
    since: number;
    refresh?: boolean;
}): Promise<CodexAgentRecord[]> {
    try {
        return await recentCodexAgentRecords({ since, refresh });
    } catch (error) {
        logger.warn({ error }, "[hub agents] codex sub-agent listing unavailable; codex sessions list without agents");
        return [];
    }
}

/** The full tree: every node carries its whole spawn prompt (the list strips it, `hubAgent` keeps it). */
async function buildTree(options: HubAgentsOptions): Promise<AgentsTree> {
    const now = options.now ?? Date.now();
    const hours = options.hours ?? DEFAULT_AGENTS_SINCE_HOURS;
    const limit = options.limit ?? DEFAULT_AGENTS_LIMIT;
    const root = options.teamsRoot ?? teamsRoot();
    const since = now - hours * 3_600_000;
    const openSessions = readOpenSessions(options);

    const [rows, workers, codexRecords] = await Promise.all([
        prof.measureAsync("parents", () =>
            options.session
                ? Promise.resolve([])
                : listAgentSessionRows({
                      providers: ["claude", "codex"],
                      refresh: options.refresh,
                      hours,
                      limit,
                      maxDiscoveryAgeMs: POLLED_LISTING_REUSE_MS,
                  })
        ),
        prof.measureAsync("workers", () => listWorkers({ now, since, promptChars: options.promptChars })),
        prof.measureAsync("codex-agents", () =>
            codexAgentRecords({
                since: options.session ? now - SESSION_AGENTS_LOOKBACK_MS : since,
                refresh: options.refresh,
            })
        ),
    ]);
    const codexTops = prof.measure("codex-tree", () =>
        attachCodexAgents(codexRecords, { now, model: null, readOnly: options.refresh === false })
    );
    const open = await openSessions;

    let parentRows: ParentRow[];
    if (options.session) {
        const one = await parentById({ id: options.session, rows, now, refresh: options.refresh });
        parentRows = one ? [one] : [];
    } else {
        parentRows = rows.map(parentRow);
        const listed = new Set(parentRows.map((row) => row.sessionId));
        const missingIds = new Set(
            [
                ...open,
                ...codexTops.keys(),
                ...workers.flatMap((worker) =>
                    worker.node.status === "running" && worker.rendezvousSession ? [worker.rendezvousSession] : []
                ),
            ].filter((id) => !listed.has(id))
        );
        const missingParents = await parentsByIds({ ids: missingIds, rows, refresh: options.refresh });
        for (const id of open) {
            if (listed.has(id)) {
                continue;
            }

            const held = missingParents.get(id);
            if (held) {
                parentRows.push(held);
                listed.add(held.sessionId);
            }
        }
        // A parent is in the window when any of its agents is, like a worker's rendezvous session.
        const byChild = await prof.measureAsync("agent-parents", () =>
            parentsOfRecentAgents(since, listed, (since) => recentAgentRecords({ since, refresh: options.refresh }))
        );
        for (const row of byChild) {
            parentRows.push(row);
            listed.add(row.sessionId);
        }

        // A Codex session older than the window whose sub-agent wrote inside it, like a Claude lead.
        for (const id of codexTops.keys()) {
            if (listed.has(id)) {
                continue;
            }

            const lead = missingParents.get(id);
            if (lead) {
                parentRows.push(lead);
                listed.add(lead.sessionId);
            }
        }

        const waiting = new Set(
            workers
                .filter((worker) => worker.node.status === "running" && worker.rendezvousSession)
                .map((worker) => worker.rendezvousSession as string)
                .filter((id) => !listed.has(id))
        );
        for (const id of waiting) {
            const extra = missingParents.get(id);
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
                row.provider === "codex"
                    ? buildCodexParent(row, codexTops.get(row.sessionId) ?? [], now, startedAtOf(row.filePath))
                    : readParent(row, bySession.get(row.sessionId) ?? [], root, {
                          now,
                          promptChars: options.promptChars,
                      })
            )
        )
    )
        .map((parent) => ({ ...parent, open: open.has(parent.sessionId) }))
        .sort((left, right) => Number(right.open) - Number(left.open))
        .slice(0, limit);
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
 * Every Claude and Codex session in the window with its agents: a Claude session's sub-agents and
 * teammates from its `subagents/` folder, a Codex session's sub-agents from the rollouts that name
 * it as their spawner, and codex and grok workers from their rendezvous session. A session is in the
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
