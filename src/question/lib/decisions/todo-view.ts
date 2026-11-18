import { canonicalAgent } from "@genesiscz/utils/agent/recipient";
import type { DecisionRecord } from "./store";

export const TASK_TITLE_CHARS = 180;
export const TASK_DETAILS_CHARS = 2000;

export interface WidgetTask {
    id: string;
    number: number;
    title: string;
    summary: string;
    truncated: boolean;
    revision: number;
    state: DecisionRecord["state"];
    updatedTs: string;
    createdTs?: string;
    blocking: boolean;
    owner?: string;
    sessionId: string;
    provider: string;
    sessionTitle?: string;
    sourceContext: Pick<
        DecisionRecord,
        | "project"
        | "cwd"
        | "repoRoot"
        | "branch"
        | "commitSha"
        | "isWorktree"
        | "worktreePath"
        | "sessionId"
        | "aiAgent"
    > & { agent?: string };
    sendUncertain?: boolean;
}
export function taskProvider(provider: string | undefined): WidgetTask["provider"] {
    const trimmed = provider?.trim();
    return trimmed ? (canonicalAgent(trimmed) ?? trimmed) : "unknown";
}
/** The fields of a to-do row the widget shows; a row of the decision log and a row of the work store both have them. */
export type WidgetTaskSource = Pick<
    DecisionRecord,
    | "id"
    | "number"
    | "title"
    | "prompt"
    | "revision"
    | "state"
    | "updatedTs"
    | "createdTs"
    | "blocking"
    | "delivery"
    | "for"
    | "sessionId"
    | "provider"
    | "sessionTitle"
    | "aiAgent"
    | "project"
    | "cwd"
    | "repoRoot"
    | "branch"
    | "commitSha"
    | "isWorktree"
    | "worktreePath"
>;

export function widgetTask(row: WidgetTaskSource): WidgetTask {
    return {
        id: row.id,
        number: row.number,
        title: (row.title || row.prompt).slice(0, TASK_TITLE_CHARS),
        summary: row.prompt.slice(0, TASK_DETAILS_CHARS),
        truncated: row.prompt.length > TASK_DETAILS_CHARS || (row.title?.length ?? 0) > TASK_TITLE_CHARS,
        revision: row.revision ?? 1,
        state: row.state,
        updatedTs: row.updatedTs,
        createdTs: row.createdTs,
        blocking: row.blocking === true,
        owner: row.for?.trim() || "agent",
        ...(row.delivery?.uncertain ? { sendUncertain: true } : {}),
        sessionId: row.sessionId,
        provider: taskProvider(row.provider),
        sessionTitle: row.sessionTitle,
        sourceContext: {
            sessionId: row.sessionId,
            agent: row.provider,
            aiAgent: row.aiAgent,
            project: row.project,
            cwd: row.cwd,
            repoRoot: row.repoRoot,
            branch: row.branch,
            commitSha: row.commitSha,
            isWorktree: row.isWorktree,
            worktreePath: row.worktreePath,
        },
    };
}
