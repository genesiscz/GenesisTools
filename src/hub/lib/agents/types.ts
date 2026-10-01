/**
 * The `tools hub agents --json` contract the hub's Agents mode renders. The shape is fixed in
 * `.claude/plans/2026-10-01-HubAgentsTab.md` ("JSON contract"); change both together.
 */

export const DEFAULT_AGENTS_SINCE_HOURS = 24;
export const DEFAULT_AGENTS_LIMIT = 50;

export const AGENT_HARNESSES = ["claude", "codex", "grok"] as const;
export type AgentHarness = (typeof AGENT_HARNESSES)[number];

export type AgentKind = "teammate" | "background" | "foreground" | "worker";

export type AgentStatus = "running" | "idle" | "completed" | "failed" | "killed";

export interface AgentNode {
    /** A Claude agent id (`a0564…`, `aE-sharedkit-4743…`), or a codex/grok worker name. */
    id: string;
    harness: AgentHarness;
    kind: AgentKind;
    /** A teammate's or a named agent's name. */
    name: string | null;
    /** The Agent call's `description`. */
    description: string | null;
    agentType: string | null;
    model: string | null;
    account: string | null;
    status: AgentStatus;
    startedAt: string | null;
    lastAt: string;
    toolCalls: number;
    /** Team inbox entries not delivered yet (`"read": false`). Teammates only; 0 otherwise. */
    unreadMail: number;
    team: string | null;
    backendType: string | null;
    /** The transcript to open: `agent-<id>.jsonl`, a codex event log, a grok turn file. */
    filePath: string | null;
    /** The whole spawn prompt (at most 4000 chars) in the one-agent door; null in the list. */
    spawnPrompt: string | null;
    /** The first 200 chars of the spawn prompt, whitespace folded: the list row and its tooltip. */
    spawnPromptPreview: string | null;
    toolUseId: string | null;
    spawnDepth: number;
    children: AgentNode[];
}

export interface AgentParent {
    sessionId: string;
    provider: AgentHarness;
    title: string | null;
    project: string | null;
    cwd: string;
    filePath: string;
    model: string | null;
    account: string | null;
    startedAt: string | null;
    lastAt: string;
    /** Written in the last `LIVE_PARENT_MS`, or has a running child. */
    live: boolean;
    children: AgentNode[];
}

export interface AgentsTree {
    generatedAt: string;
    parents: AgentParent[];
    /** Workers whose rendezvous session is not a listed parent. */
    orphans: AgentNode[];
}

export interface MailMessage {
    at: string | null;
    text: string;
}

export interface AgentMail {
    received: Array<MailMessage & { from: string }>;
    sent: Array<MailMessage & { to: string }>;
    unread: Array<MailMessage & { from: string }>;
}
