import { existsSync, statSync } from "node:fs";
import { canonicalAgent } from "@app/handoff/targeting";
import { decisionFiles } from "@app/question/lib/decisions/read";
import {
    createTodo,
    type DecisionRecord,
    kindOf,
    readDecisions,
    reviseTodo,
    type TodoUpdateSnapshot,
    updateTodo,
} from "@app/question/lib/decisions/store";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { z } from "zod";
import type { WidgetCard } from "./snapshot";

const prof = profiler.scope("widget");
const MAX_LEDGER_BYTES = 16 * 1024 * 1024;
export const WIDGET_TASK_SCOPES = ["active", "completed", "dismissed", "all"] as const;
export const WIDGET_TASK_ACTIONS = ["acknowledge", "complete", "reopen", "dismiss"] as const;
export const WIDGET_TASK_STATES = ["open", "acknowledged", "implemented", "dismissed"] as const;
export const widgetTaskFiltersSchema = z.object({
    scope: z.enum(WIDGET_TASK_SCOPES).default("active"),
    projects: z.array(z.string()).default([]),
    sessions: z.array(z.string()).default([]),
    limit: z.number().int().min(1).max(250).default(200),
});
export type WidgetTaskFilters = z.infer<typeof widgetTaskFiltersSchema>;
const shownTaskSchema = z.object({
    revision: z.number().int().positive(),
    state: z.enum(WIDGET_TASK_STATES),
    updatedTs: z.string().datetime(),
    sessionId: z.string().min(1),
    provider: z.string().min(1).max(512),
});
export const widgetTaskActionSchema = z.object({
    id: z.string().min(1),
    action: z.enum(WIDGET_TASK_ACTIONS),
    expected: shownTaskSchema,
});
export type WidgetTaskAction = z.infer<typeof widgetTaskActionSchema>;
/** The session a task the user writes without choosing one belongs to. */
export const LOCAL_TASK_SESSION = "local";
const taskTextSchema = {
    title: z.string().trim().min(1, "A task needs a title").max(180),
    details: z.string().trim().max(2000).optional(),
};
export const widgetTaskCreateSchema = z.object({
    ...taskTextSchema,
    /** `provider:sessionId`, as `tasks list` reports sessions; absent for a local task. */
    session: z
        .string()
        .regex(/^[^:\s]+:\S+$/, "A session is provider:sessionId")
        .optional(),
    sessionTitle: z.string().trim().max(200).optional(),
    project: z.string().trim().max(512).optional(),
    cwd: z.string().trim().max(4096).optional(),
});
export const widgetTaskEditSchema = z.object({
    id: z.string().min(1),
    ...taskTextSchema,
    expected: shownTaskSchema,
});
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
    sourceContext: NonNullable<WidgetCard["sourceContext"]>;
}
export interface WidgetTaskSnapshot {
    tasks: WidgetTask[];
    total: number;
    activeCount: number;
    truncated: boolean;
    sourcePath: string;
    sourceStamp: string;
    projects: string[];
    sessions: { id: string; title: string }[];
}
const taskCache = new Map<string, { stamp: string; tasks: WidgetTask[] }>();

export function taskProvider(provider: string | undefined): WidgetTask["provider"] {
    const trimmed = provider?.trim();
    return trimmed ? (canonicalAgent(trimmed) ?? trimmed) : "unknown";
}
export function widgetTask(row: DecisionRecord): WidgetTask {
    return {
        id: row.id,
        number: row.number,
        title: (row.title || row.prompt).slice(0, 180),
        summary: row.prompt.slice(0, 2000),
        truncated: row.prompt.length > 2000,
        revision: row.revision ?? 1,
        state: row.state,
        updatedTs: row.updatedTs,
        createdTs: row.createdTs,
        blocking: row.blocking === true,
        owner: row.for,
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

/** A metadata view of the canonical TODO ledger. Missing files are empty; inspecting never creates storage. */
export function listWidgetTasks({
    file = decisionFiles().file,
    filters,
    signal,
}: {
    file?: string;
    filters?: Partial<WidgetTaskFilters>;
    signal?: AbortSignal;
} = {}): WidgetTaskSnapshot {
    signal?.throwIfAborted();
    const options = widgetTaskFiltersSchema.parse(filters ?? {});
    if (!existsSync(file)) {
        return {
            tasks: [],
            total: 0,
            activeCount: 0,
            truncated: false,
            sourcePath: file,
            sourceStamp: "missing",
            projects: [],
            sessions: [],
        };
    }
    const stat = statSync(file);
    if (stat.size > MAX_LEDGER_BYTES) {
        throw new Error("The task ledger is too large for the Widget. Open the question task list to inspect it.");
    }
    const stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    let cached = taskCache.get(file);
    if (cached?.stamp !== stamp) {
        const tasks = prof.measure("tasks-read", () =>
            readDecisions(file)
                .filter((row) => kindOf(row) === "todo")
                .map(widgetTask)
        );
        cached = { stamp, tasks };
        if (taskCache.size >= 4) {
            taskCache.delete(taskCache.keys().next().value ?? "");
        }
        taskCache.set(file, cached);
        logger.debug({ file, count: tasks.length, bytes: stat.size }, "Widget task metadata read");
    }
    const selected = cached.tasks
        .filter((task) => {
            if (
                options.projects.length &&
                !options.projects.includes(task.sourceContext.project ?? task.sourceContext.cwd ?? "")
            ) {
                return false;
            }
            if (options.sessions.length && !options.sessions.includes(`${task.provider}:${task.sessionId}`)) {
                return false;
            }
            return (
                options.scope === "all" ||
                (options.scope === "active" && ["open", "acknowledged"].includes(task.state)) ||
                (options.scope === "completed" && task.state === "implemented") ||
                (options.scope === "dismissed" && task.state === "dismissed")
            );
        })
        .sort(
            (a, b) =>
                Number(b.blocking) - Number(a.blocking) ||
                b.updatedTs.localeCompare(a.updatedTs) ||
                a.id.localeCompare(b.id)
        );
    return {
        projects: [
            ...new Set(
                cached.tasks.map((task) => task.sourceContext.project ?? task.sourceContext.cwd ?? "").filter(Boolean)
            ),
        ].sort(),
        sessions: [
            ...new Map(
                cached.tasks.map((task) => [
                    `${task.provider}:${task.sessionId}`,
                    {
                        id: `${task.provider}:${task.sessionId}`,
                        title: task.sessionTitle || task.sessionId,
                    },
                ])
            ).values(),
        ].sort((a, b) => a.title.localeCompare(b.title)),
        tasks: structuredClone(selected.slice(0, options.limit)),
        total: selected.length,
        activeCount: cached.tasks.filter((task) => ["open", "acknowledged"].includes(task.state)).length,
        truncated: selected.length > options.limit,
        sourcePath: file,
        sourceStamp: stamp,
    };
}

export async function updateWidgetTask({
    input,
    files = decisionFiles(),
    signal,
}: {
    input: unknown;
    files?: { file: string; events: string };
    signal?: AbortSignal;
}) {
    const request = widgetTaskActionSchema.parse(input);
    signal?.throwIfAborted();
    const states = {
        acknowledge: "acknowledged",
        complete: "implemented",
        reopen: "open",
        dismiss: "dismissed",
    } as const;
    const expected: TodoUpdateSnapshot = request.expected;
    const row = await updateTodo({ ...files, id: request.id, state: states[request.action], expected, signal });
    taskCache.delete(files.file);
    logger.debug({ id: row.id, state: row.state, revision: row.revision ?? 1 }, "Widget task action saved");
    return {
        task: widgetTask(row),
        receipt: {
            id: row.id,
            action: request.action,
            from: expected.state,
            state: row.state,
            revision: row.revision ?? 1,
            at: row.updatedTs,
            saved: true,
        },
    };
}

/** A task the user writes in the widget: on a session they picked, or on the local task list. */
export async function createWidgetTask({
    input,
    files = decisionFiles(),
    signal,
    now,
}: {
    input: unknown;
    files?: { file: string; events: string };
    signal?: AbortSignal;
    now?: () => string;
}) {
    const request = widgetTaskCreateSchema.parse(input);
    const separator = request.session?.indexOf(":") ?? -1;
    const session = request.session
        ? { provider: request.session.slice(0, separator), sessionId: request.session.slice(separator + 1) }
        : { provider: undefined, sessionId: LOCAL_TASK_SESSION };
    const row = await createTodo({
        ...files,
        signal,
        now,
        todo: {
            title: request.title,
            details: request.details,
            ...session,
            sessionTitle: request.sessionTitle ?? (request.session ? undefined : "Local tasks"),
            project: request.project,
            cwd: request.cwd,
        },
    });
    taskCache.delete(files.file);
    logger.debug({ id: row.id, session: row.sessionId, provider: row.provider }, "Widget task created");
    return {
        task: widgetTask(row),
        receipt: {
            id: row.id,
            action: "create",
            state: row.state,
            revision: row.revision ?? 1,
            at: row.updatedTs,
            saved: true,
        },
    };
}

/** New title and text for an open task, checked against the version the user edited. */
export async function editWidgetTask({
    input,
    files = decisionFiles(),
    signal,
    now,
}: {
    input: unknown;
    files?: { file: string; events: string };
    signal?: AbortSignal;
    now?: () => string;
}) {
    const request = widgetTaskEditSchema.parse(input);
    const row = await reviseTodo({
        ...files,
        id: request.id,
        title: request.title,
        details: request.details,
        expected: request.expected,
        signal,
        now,
    });
    taskCache.delete(files.file);
    logger.debug({ id: row.id, revision: row.revision ?? 1 }, "Widget task edited");
    return {
        task: widgetTask(row),
        receipt: {
            id: row.id,
            action: "edit",
            state: row.state,
            revision: row.revision ?? 1,
            at: row.updatedTs,
            saved: true,
        },
    };
}
