import type { TaskNotification } from "@genesiscz/utils/ai/transcripts/file-scan";
import type { SessionSubagent } from "@genesiscz/utils/ai/transcripts/subagents";
import type { SessionTeam } from "./team";
import type { AgentHarness, AgentKind, AgentNode, AgentParent, AgentStatus } from "./types";
import type { WorkerAgent } from "./workers";

/** A parent written this recently is live even with no running child. */
export const LIVE_PARENT_MS = 2 * 60 * 1000;

/** The parent row fields the tree needs, as `listAgentSessionRows` returns them. */
export interface ParentRow {
    /** Whose session this is; Claude when absent. */
    provider?: AgentHarness;
    sessionId: string;
    title: string | null;
    project: string | null;
    cwd: string;
    filePath: string;
    model: string | null;
    account: string | null;
    mtime: number;
}

export interface ParentInput {
    row: ParentRow;
    startedAt: string | null;
    subagents: SessionSubagent[];
    /** The parent's `<task-notification>` statuses by task id (`readTaskNotifications`). */
    notifications: Map<string, TaskNotification>;
    team: SessionTeam | null;
    /** Undelivered inbox entries per teammate name. */
    unread: Map<string, number>;
    workers: WorkerAgent[];
}

function notificationStatus(status: string): AgentStatus {
    switch (status.toLowerCase()) {
        case "failed":
        case "error":
            return "failed";
        case "killed":
        case "stopped":
        case "cancelled":
        case "canceled":
            return "killed";
        default:
            return "completed";
    }
}

function isTeammate(agent: SessionSubagent): boolean {
    return agent.taskKind === "in_process_teammate" || agent.teamName !== null;
}

function kindOf(agent: SessionSubagent): AgentKind {
    if (isTeammate(agent)) {
        return "teammate";
    }

    return agent.requestShape === "background" ? "background" : "foreground";
}

/**
 * - A transcript whose last record is mid-work and fresh is `running`, whatever else says.
 * - Otherwise the parent's last `<task-notification>` for the agent decides.
 * - A finished agent is `completed`, except a teammate still in the team config, which is `idle`
 *   (it waits for mail). A teammate that approved its shutdown is finished (`listSubagents`).
 * - An agent that stopped mid-work is `killed`, teammate or not.
 */
export function agentStatus(
    agent: SessionSubagent,
    notification: TaskNotification | undefined,
    member: boolean
): AgentStatus {
    if (agent.state === "running") {
        return "running";
    }

    if (notification) {
        return notificationStatus(notification.status);
    }

    if (agent.state === "done") {
        return isTeammate(agent) && member ? "idle" : "completed";
    }

    return "killed";
}

export const SPAWN_PROMPT_PREVIEW_CHARS = 200;

/** The first `SPAWN_PROMPT_PREVIEW_CHARS` of a spawn prompt, whitespace folded, `…` when cut. */
export function promptPreview(prompt: string | null): string | null {
    if (!prompt) {
        return null;
    }

    const folded = prompt.replace(/\s+/g, " ").trim();
    return folded.length > SPAWN_PROMPT_PREVIEW_CHARS ? `${folded.slice(0, SPAWN_PROMPT_PREVIEW_CHARS - 1)}…` : folded;
}

/** The list form: previews only. The full prompt comes from the one-agent door (`hubAgent`). */
export function withoutFullPrompts(nodes: AgentNode[]): AgentNode[] {
    return nodes.map((node) => ({ ...node, spawnPrompt: null, children: withoutFullPrompts(node.children) }));
}

function usefulModel(model: string | null): string | null {
    return model && model !== "inherit" ? model : null;
}

export function claudeAgentNode(agent: SessionSubagent, input: ParentInput): AgentNode {
    const teammate = isTeammate(agent);
    const member = agent.name ? input.team?.members.get(agent.name) : undefined;
    return {
        id: agent.id,
        harness: "claude",
        kind: kindOf(agent),
        name: agent.name,
        description: agent.description,
        agentType: agent.agentType,
        model:
            agent.transcriptModel ?? usefulModel(agent.model) ?? usefulModel(member?.model ?? null) ?? input.row.model,
        account: input.row.account,
        status: agentStatus(agent, input.notifications.get(agent.id), member !== undefined),
        startedAt: agent.startedAt,
        lastAt: agent.lastAt,
        toolCalls: agent.toolCalls ?? 0,
        unreadMail: teammate && agent.name ? (input.unread.get(agent.name) ?? 0) : 0,
        team: teammate ? (agent.teamName ?? input.team?.name ?? null) : null,
        backendType: member?.backendType ?? (agent.taskKind === "in_process_teammate" ? "in-process" : null),
        filePath: agent.filePath,
        spawnPrompt: agent.spawnPrompt,
        spawnPromptPreview: promptPreview(agent.spawnPrompt),
        toolUseId: agent.toolUseId,
        spawnDepth: agent.spawnDepth ?? (teammate ? 0 : 1),
        children: [],
    };
}

function statusRank(node: AgentNode): number {
    return node.status === "running" ? 0 : 1;
}

/** Running first, then the most recent activity first; applied at every level. */
export function sortNodes(nodes: AgentNode[]): AgentNode[] {
    for (const node of nodes) {
        sortNodes(node.children);
    }

    return nodes.sort((a, b) => statusRank(a) - statusRank(b) || b.lastAt.localeCompare(a.lastAt));
}

export function hasRunning(nodes: AgentNode[]): boolean {
    return nodes.some((node) => node.status === "running" || hasRunning(node.children));
}

/**
 * Hangs an agent under the agent whose transcript holds the Agent call that started it (its
 * `toolUseId` among that agent's `agentCalls`). Everything else stays at the top.
 */
export function nestAgents(nodes: AgentNode[], agentCallsById: Map<string, string[]>): AgentNode[] {
    const owner = new Map<string, AgentNode>();
    const byId = new Map(nodes.map((node) => [node.id, node]));
    for (const [id, calls] of agentCallsById) {
        const node = byId.get(id);
        if (!node) {
            continue;
        }

        for (const call of calls) {
            owner.set(call, node);
        }
    }

    const top: AgentNode[] = [];
    for (const node of nodes) {
        const parent = node.toolUseId ? owner.get(node.toolUseId) : undefined;
        if (parent && parent !== node) {
            parent.children.push(node);
        } else {
            top.push(node);
        }
    }

    return top;
}

export function buildParent(input: ParentInput, now: number): AgentParent {
    const claude = input.subagents.map((agent) => claudeAgentNode(agent, input));
    const calls = new Map(input.subagents.map((agent) => [agent.id, agent.agentCalls ?? []]));
    const children = sortNodes([...nestAgents(claude, calls), ...input.workers.map((worker) => worker.node)]);
    return {
        sessionId: input.row.sessionId,
        provider: "claude",
        title: input.row.title,
        project: input.row.project,
        cwd: input.row.cwd,
        filePath: input.row.filePath,
        model: input.row.model,
        account: input.row.account,
        startedAt: input.startedAt,
        lastAt: new Date(input.row.mtime).toISOString(),
        live: now - input.row.mtime < LIVE_PARENT_MS || hasRunning(children),
        children,
    };
}

/** Live parents first, then the most recent activity first. */
export function sortParents(parents: AgentParent[]): AgentParent[] {
    return parents.sort((a, b) => Number(b.live) - Number(a.live) || b.lastAt.localeCompare(a.lastAt));
}
