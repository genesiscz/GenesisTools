import { isRecord } from "./parse-helpers";

export type CodexActivity = "code-review" | "permission-review" | "other" | "unclassified";

export interface CodexTask {
    id: string;
    startedAt: string;
    completedAt?: string;
    completed: boolean;
    kind: CodexActivity;
    evidence: "metadata" | "completion-text" | "none";
}

export interface CodexContext {
    threadId?: string;
    parentThreadId?: string;
    agentPath?: string;
    permissionReviewer?: boolean;
    task?: CodexTask;
}

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** Only explicit review results count; an agent named "review" can also debug CI. */
export function completionActivity(message: string): CodexActivity {
    if (!message || message.startsWith("gAAAAA")) {
        return "unclassified";
    }

    if (/^(?:\*\*)?(?:The CI stop|CI (?:timeout|failure)|The (?:build|test) failure)/i.test(message)) {
        return "other";
    }

    const hasResult = /(?:findings?|reviewed the fixes|saved the (?:full )?review)/i.test(message);
    const hasCode =
        /(?:code review|\.tsx?\b|\.py\b|\.rs\b|\.php\b|\.swift\b|\.md\b|login changes|history findings)/i.test(message);
    return hasResult && hasCode ? "code-review" : "other";
}

/** Task objects are shared by emitted events so completion can label the whole pass. */
export function updateCodexContext(
    context: CodexContext,
    type: string | undefined,
    payload: Record<string, unknown>,
    timestamp: string
): void {
    if (type === "session_meta" && !context.threadId) {
        context.threadId = text(payload.id);
        const source = isRecord(payload.source) ? payload.source : undefined;
        const subagent = source && isRecord(source.subagent) ? source.subagent : undefined;
        context.permissionReviewer = subagent?.other === "guardian";
        const spawn = subagent && isRecord(subagent.thread_spawn) ? subagent.thread_spawn : undefined;
        context.parentThreadId = text(spawn?.parent_thread_id);
        context.agentPath = text(spawn?.agent_path);
    }

    if (type === "event_msg" && payload.type === "task_started") {
        context.task = {
            id: text(payload.turn_id) ?? timestamp,
            startedAt: timestamp,
            completed: false,
            kind: context.permissionReviewer ? "permission-review" : "unclassified",
            evidence: context.permissionReviewer ? "metadata" : "none",
        };
    }

    if (type === "turn_context") {
        const turnId = text(payload.turn_id);
        if (!context.task || (turnId && context.task.id !== turnId)) {
            context.task = {
                id: turnId ?? timestamp,
                startedAt: timestamp,
                completed: false,
                kind: "unclassified",
                evidence: "none",
            };
        }

        if (turnId) {
            context.task.id = turnId;
        }

        if (payload.model === "codex-auto-review" || context.permissionReviewer) {
            context.task.kind = "permission-review";
            context.task.evidence = "metadata";
        }
    }

    if (type !== "event_msg" || !context.task) {
        return;
    }

    if (payload.type === "entered_review_mode") {
        context.task.kind = "code-review";
        context.task.evidence = "metadata";
    }

    if (payload.type === "task_complete" || payload.type === "task_completed") {
        context.task.completed = true;
        context.task.completedAt = timestamp;

        if (context.task.evidence !== "metadata") {
            const result = completionActivity(text(payload.last_agent_message) ?? "");
            const dedicatedReviewer = context.parentThreadId && /review/i.test(context.agentPath ?? "");
            context.task.kind = result === "code-review" && !dedicatedReviewer ? "other" : result;
            context.task.evidence = context.task.kind === "unclassified" ? "none" : "completion-text";
        }
    }
}
