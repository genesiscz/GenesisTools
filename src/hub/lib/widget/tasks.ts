import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { decisionFiles } from "@app/question/lib/decisions/read";
import {
    createTodo,
    type DecisionRecord,
    kindOf,
    readDecisions,
    readStoredTodoRows,
    reviseTodo,
    type TodoUpdateSnapshot,
    updateTodo,
} from "@app/question/lib/decisions/store";
import { canonicalAgent } from "@genesiscz/utils/agent/recipient";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { type ClaimedHandoff, claimedHandoffTree, handoffClaimantIds } from "@genesiscz/utils/work/claimed-handoffs";
import { type ProjectCounts, projectCounts } from "@genesiscz/utils/work/read";
import { workDbPath } from "@genesiscz/utils/work/store/db";
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
/** The most text the widget shows and writes: a longer task arrives as an excerpt (`truncated`). */
const TASK_TITLE_CHARS = 180;
const TASK_DETAILS_CHARS = 2000;
const taskTextSchema = {
    title: z.string().trim().min(1, "A task needs a title").max(TASK_TITLE_CHARS),
    details: z.string().trim().max(TASK_DETAILS_CHARS).optional(),
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
    /** Per project: items spotted, items reopened, outside changes held (work-items P8). Absent before the store. */
    work?: ProjectCounts[];
    claimedHandoffs?: ClaimedHandoff[];
    /** Other files that can change the result while the Tasks module is open. */
    additionalSourcePaths?: string[];
}
const taskCache = new Map<string, { stamp: string; tasks: WidgetTask[] }>();

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

interface WidgetTaskListOptions {
    file?: string;
    /** The work store to read from (work-items P9). Default: the user's store when no log file is named. */
    store?: string;
    filters?: Partial<WidgetTaskFilters>;
    signal?: AbortSignal;
}

/** A metadata view of the canonical TODO ledger. Missing files are empty; inspecting never creates storage. */
export function listWidgetTasks({
    file: fileArg,
    store: storeArg,
    filters,
    signal,
}: WidgetTaskListOptions = {}): WidgetTaskSnapshot {
    signal?.throwIfAborted();
    const options = widgetTaskFiltersSchema.parse(filters ?? {});
    const file = fileArg ?? decisionFiles().file;
    const store = storeArg ?? (fileArg === undefined ? workDbPath() : undefined);
    const fromStore = store !== undefined ? readStoreTasks(store) : null;
    const storeHasTodos = fromStore !== null && fromStore.tasks.length > 0;
    if (!storeHasTodos && !existsSync(file)) {
        return {
            tasks: [],
            total: 0,
            activeCount: 0,
            truncated: false,
            sourcePath: file,
            sourceStamp: "missing",
            projects: [],
            sessions: [],
            ...(fromStore ? { work: fromStore.work } : {}),
        };
    }
    let cached: { stamp: string; tasks: WidgetTask[] } | undefined;
    let stamp: string;
    if (storeHasTodos) {
        stamp = `store:${fromStore.stamp}`;
        cached = { stamp, tasks: fromStore.tasks };
    } else {
        const stat = statSync(file);
        if (stat.size > MAX_LEDGER_BYTES) {
            throw new Error("The task ledger is too large for the Widget. Open the question task list to inspect it.");
        }
        stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
        cached = taskCache.get(file);
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
        // Session to-dos come from the log until imported. A store write lands in the WAL between checkpoints.
        sourcePath: storeHasTodos ? `${store}-wal` : file,
        sourceStamp: stamp,
        ...(fromStore !== null ? { work: fromStore.work } : {}),
    };
}

const storeCache = new Map<string, { stamp: string; tasks: WidgetTask[]; work: ProjectCounts[] }>();

/**
 * Work counts are available even before the first to-do import. Only the to-do rows fall back to the decision log.
 */
function readStoreTasks(path: string): { stamp: string; tasks: WidgetTask[]; work: ProjectCounts[] } | null {
    if (!existsSync(path)) {
        return null;
    }

    let connection: Database | undefined;
    try {
        const db = new Database(path, { readonly: true });
        connection = db;
        return db.transaction(() => {
            const last = db.query<{ seq: number | null }, []>("SELECT MAX(seq) AS seq FROM changes").get();
            const head = String(last?.seq ?? 0);
            const cached = storeCache.get(path);

            if (cached?.stamp === head) {
                return cached;
            }

            const stamp = head;
            const tasks = prof.measure("tasks-read-store", () =>
                readStoredTodoRows(db)
                    .filter((row) => kindOf(row) === "todo")
                    .map(widgetTask)
            );
            const work = projectCounts(db);
            storeCache.set(path, { stamp, tasks, work });
            logger.debug({ path, count: tasks.length }, "Widget task metadata read from the work store");
            return { stamp, tasks, work };
        })();
    } catch (error) {
        logger.warn({ err: error, path }, "Widget tasks: the work store is unreadable; reading the decision log");
        return null;
    } finally {
        connection?.close();
    }
}

/** Session hosts know running turns and panes. An unhosted terminal can also have a registry entry or a named process. */
async function localClaimSessions(ids: string[]): Promise<ReadonlySet<string>> {
    const { liveClaudeSessionIds } = await import("@genesiscz/utils/claude/peer-message");
    const registry = liveClaudeSessionIds();
    const live = new Set(ids.filter((id) => registry?.has(id.toLowerCase())));
    const remaining = ids.filter((id) => !live.has(id));
    if (remaining.length === 0) {
        return live;
    }

    const { describeSessionHosts } = await import("@app/ai/lib/session-host/registry");
    const hosts = await describeSessionHosts(remaining);
    const withoutLiveHost = hosts.filter(({ host }) => host?.live !== true);
    if (withoutLiveHost.length > 0) {
        const { readOpenSessions } = await import("../agents");
        const open = await readOpenSessions({ psTimeoutMs: 3_000 });
        for (const { sessionId } of withoutLiveHost) {
            if (open.has(sessionId)) {
                live.add(sessionId);
            }
        }
    }

    for (const { sessionId, host } of hosts) {
        if (host?.live) {
            live.add(sessionId);
        }
    }

    return live;
}

/** Both widget doors use the current local sessions. A session can exit without writing the work store. */
export async function listLiveWidgetTasks({
    liveSessions = localClaimSessions,
    root,
    ...options
}: WidgetTaskListOptions & {
    root?: string;
    liveSessions?: (ids: string[]) => Promise<ReadonlySet<string>>;
} = {}): Promise<WidgetTaskSnapshot> {
    const snapshot = listWidgetTasks(options);
    const path = options.store ?? (options.file === undefined ? workDbPath() : undefined);
    if (!path) {
        return snapshot;
    }

    const wal = `${path}-wal`;
    const paths = new Set([path, wal]);
    if (snapshot.work !== undefined) {
        const db = new Database(path, { readonly: true });
        let tree: ClaimedHandoff[] = [];
        try {
            const claimants = handoffClaimantIds(db);
            if (claimants.length > 0) {
                const { widgetRosterCachePath } = await import("./roster-cache");
                paths.add(widgetRosterCachePath(root));
                const live = await liveSessions(claimants);
                options.signal?.throwIfAborted();
                tree = claimedHandoffTree(db, live);
            }
        } finally {
            db.close();
        }

        const sessionKey = (claim: ClaimedHandoff["claimants"][number]) =>
            `${taskProvider(claim.harness)}:${claim.sessionId}`;
        const projects = new Set(snapshot.projects);
        const sessions = new Map(snapshot.sessions.map((session) => [session.id, session]));
        for (const handoff of tree) {
            projects.add(handoff.project);
            for (const claim of handoff.claimants) {
                const id = sessionKey(claim);
                if (!sessions.has(id)) {
                    sessions.set(id, { id, title: claim.title });
                }
            }
        }

        snapshot.projects = [...projects].sort();
        snapshot.sessions = [...sessions.values()].sort((a, b) => a.title.localeCompare(b.title));
        const { projects: projectFilter = [], sessions: sessionFilter = [] } = options.filters ?? {};
        snapshot.claimedHandoffs = tree.filter(
            (handoff) =>
                (!projectFilter.length || projectFilter.includes(handoff.project)) &&
                (!sessionFilter.length || handoff.claimants.some((claim) => sessionFilter.includes(sessionKey(claim))))
        );
    }

    paths.delete(snapshot.sourcePath);
    snapshot.additionalSourcePaths = [...paths];
    return snapshot;
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
        // The widget shows a long task as an excerpt; saving that excerpt would cut the stored text to it.
        beforeRevise: (stored) => {
            if (!widgetTask(stored).truncated) {
                return;
            }

            const limit =
                (stored.title?.length ?? 0) > TASK_TITLE_CHARS
                    ? `a ${TASK_TITLE_CHARS}-character title`
                    : `${TASK_DETAILS_CHARS} characters`;
            throw new Error(
                `This task is longer than the widget shows (${limit}), so it cannot be edited here without cutting it. Change it where it was written.`
            );
        },
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
