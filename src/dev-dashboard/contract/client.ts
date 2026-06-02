import type {
    AttachTmuxResult,
    ClassifiedLogEntry,
    DashboardSendTarget,
    EnrichedQaEntry,
    KillPortResult,
    PortsResult,
    ProcessSort,
    PublishedNote,
    SavedCommand,
    SavedCommandInput,
    TodoPriority,
    TtydSession,
} from "@app/dev-dashboard/contract/dto";
import type {
    AttentionRes,
    CmuxLayoutRes,
    CmuxSnapshotRes,
    CommandsRes,
    ObsidianNoteRes,
    ObsidianTreeRes,
    ProcessesRes,
    PulseHistoryRes,
    PulseRes,
    QaLogRes,
    TmuxPresetRestoreRes,
    TmuxPresetSaveRes,
    TmuxPresetsRes,
    TmuxSessionsRes,
    TodosRes,
    TtydListRes,
    WeatherRes,
} from "@app/dev-dashboard/contract/endpoints";
import { paths, QA_STREAM_PATH } from "@app/dev-dashboard/contract/endpoints";
import { SafeJSON } from "@app/utils/json";

/** Minimal EventSource shape. Web injects `window.EventSource`; RN injects an
 * `expo/fetch`-backed adapter (see mobile plan 04). Keeps the contract transport-free. */
export interface EventSourceLike {
    close(): void;
    onmessage: ((ev: { data: string }) => void) | null;
    onerror: ((ev: unknown) => void) | null;
}

export interface DashboardClientOptions {
    /** e.g. "" (same-origin web) or "http://mac.local:3042" (mobile). */
    baseUrl: string;
    /** Injected fetch — `window.fetch` on web, `expo/fetch` on RN. */
    fetch: typeof fetch;
    /** Returns the Authorization header value (e.g. "Basic …"), or undefined. */
    authHeader?: () => string | undefined;
    /** Injected EventSource factory for the QA SSE stream (transport pick lives in the consumer). */
    eventSourceFactory?: (url: string) => EventSourceLike;
}

export interface QaSubscription {
    close(): void;
}

export interface BuildLogSubscription {
    close(): void;
}

export function createDashboardClient(opts: DashboardClientOptions) {
    const { baseUrl, fetch: fetchImpl } = opts;

    async function get<T>(path: string, init?: RequestInit): Promise<T> {
        const auth = opts.authHeader?.();
        const res = await fetchImpl(`${baseUrl}${path}`, {
            ...init,
            headers: {
                "Content-Type": "application/json",
                ...(auth ? { Authorization: auth } : {}),
                ...(init?.headers ?? {}),
            },
        });

        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`${path} -> ${res.status}: ${text}`);
        }

        return SafeJSON.parse(await res.text(), { strict: true }) as T;
    }

    function post<T>(path: string, body: unknown, method = "POST"): Promise<T> {
        return get<T>(path, { method, body: SafeJSON.stringify(body ?? {}) });
    }

    return {
        // Escape hatch — any route is callable with a caller-specified type. Deferred
        // features (claude/daemon/containers/todos) use these until precisely typed.
        get,
        post,

        system: {
            pulse: () => get<PulseRes>(paths.pulse()),
            pulseHistory: (metric: string, minutes: number) =>
                get<PulseHistoryRes>(paths.pulseHistory(metric, minutes)),
        },
        weather: () => get<WeatherRes>(paths.weather()),
        processes: {
            list: (sort: ProcessSort = "rss", limit?: number) => get<ProcessesRes>(paths.processes(sort, limit)),
            kill: (pid: number) => post<{ ok: boolean }>(paths.processesKill(), { pid }),
        },
        ports: {
            list: () => get<PortsResult>(paths.ports()),
            kill: (pid: number, expectedCommand?: string) =>
                post<KillPortResult>(paths.portsKill(), { pid, expectedCommand }),
        },
        tmux: {
            sessions: () => get<TmuxSessionsRes>(paths.tmuxSessions()),
            create: (body: { name?: string; cwd?: string; command?: string } = {}) =>
                post<{ sessionName: string; cwd: string; command: string }>(paths.tmuxCreate(), body),
            rename: (body: { from: string; to: string }) => post<{ sessionName: string }>(paths.tmuxRename(), body),
        },
        presets: {
            list: () => get<TmuxPresetsRes>(paths.tmuxPresets()),
            save: (body: { name: string; note?: string; prefix?: string }) =>
                post<TmuxPresetSaveRes>(paths.tmuxPresetSave(), body),
            restore: (name: string) => post<TmuxPresetRestoreRes>(paths.tmuxPresetRestore(), { name }),
            remove: (name: string) => post<{ removed: boolean }>(paths.tmuxPresetDelete(), { name }, "DELETE"),
        },
        ttyd: {
            list: () => get<TtydListRes>(paths.ttydList()),
            spawn: (body: { command?: string; cwd?: string; tmuxSessionName?: string } = {}) =>
                post<{ session: TtydSession }>(paths.ttydSpawn(), body),
            kill: (id: string, killTmux = false) => post<{ ok: boolean }>(paths.ttydKill(), { id, killTmux }),
            rename: (id: string, name: string) => post<{ ok: boolean }>(paths.ttydRename(), { id, name }),
        },
        cmux: {
            snapshot: () => get<CmuxSnapshotRes>(paths.cmuxSnapshot()),
            layout: () => get<CmuxLayoutRes>(paths.cmuxLayout()),
            createTerminal: (body: { cwd?: string } = {}) =>
                post<{ result: AttachTmuxResult }>(paths.cmuxCreateTerminal(), body),
            sendSession: (body: { tmuxSessionName: string; target: DashboardSendTarget; cwd?: string }) =>
                post<{ result: AttachTmuxResult }>(paths.cmuxSendSession(), body),
            removeSession: (body: { tmuxSessionName: string }) =>
                post<{ removed: number }>(paths.cmuxRemoveSession(), body),
            attach: (body: { workspaceId: string; paneId: string }) => post<{ ok: boolean }>(paths.cmuxAttach(), body),
            rename: (body: { workspaceId: string; surfaceId?: string; title: string }) =>
                post<{ ok: boolean }>(paths.cmuxRename(), body),
        },
        commands: {
            list: () => get<CommandsRes>(paths.commands()),
            create: (body: SavedCommandInput) => post<{ command: SavedCommand }>(paths.commands(), body),
            delete: (id: string) => post<{ removed: number }>(paths.commands(), { id }, "DELETE"),
        },
        obsidian: {
            tree: () => get<ObsidianTreeRes>(paths.obsidianTree()),
            note: (path: string) => get<ObsidianNoteRes>(paths.obsidianNote(path)),
            mkdir: (relativeDir: string) =>
                post<{ ok: boolean; relativeDir: string }>(paths.obsidianMkdir(), { relativeDir }),
            publish: (path: string) => post<{ note: PublishedNote }>(paths.obsidianPublish(), { path }),
            unpublish: (slug: string) => post<{ remaining: PublishedNote[] }>(paths.obsidianUnpublish(), { slug }),
        },
        qa: {
            log: (q?: Parameters<typeof paths.qaLog>[0]) => get<QaLogRes>(paths.qaLog(q)),
            read: (ids: string[], unread = false) =>
                post<{ ok: boolean; updated: number }>(paths.qaRead(), { ids, unread }),
            subscribe: (onEntry: (entry: EnrichedQaEntry) => void): QaSubscription => {
                if (!opts.eventSourceFactory) {
                    throw new Error("eventSourceFactory required to subscribe to the QA stream");
                }

                const source = opts.eventSourceFactory(`${baseUrl}${QA_STREAM_PATH}`);
                source.onmessage = (ev) => {
                    try {
                        onEntry(SafeJSON.parse(ev.data, { strict: true }) as EnrichedQaEntry);
                    } catch {
                        // A malformed data frame is non-actionable client-side and must not kill the
                        // stream; keep-alive comment frames never reach onmessage. Skip and continue.
                    }
                };

                return { close: () => source.close() };
            },
        },
        buildLog: {
            subscribe: (logFile: string, onEntry: (entry: ClassifiedLogEntry) => void): BuildLogSubscription => {
                if (!opts.eventSourceFactory) {
                    throw new Error("eventSourceFactory required to subscribe to the build-log tail");
                }

                const source = opts.eventSourceFactory(`${baseUrl}${paths.daemonRunTail(logFile)}`);
                source.onmessage = (ev) => {
                    try {
                        onEntry(SafeJSON.parse(ev.data, { strict: true }) as ClassifiedLogEntry);
                    } catch {
                        // A malformed data frame is non-actionable client-side and must not kill the
                        // stream; keep-alive comment frames never reach onmessage. Skip and continue.
                    }
                };

                return { close: () => source.close() };
            },
        },
        attention: {
            list: () => get<AttentionRes>(paths.attention()),
        },
        todos: {
            list: (listIds: string[] = [], includeCompleted = false) =>
                get<TodosRes>(paths.todos(listIds, includeCompleted)),
            add: (body: { title: string; listName?: string; due?: string; priority?: TodoPriority; notes?: string }) =>
                post<{ reminderId: string }>(paths.todoAdd(), body),
            complete: (reminderId: string) => post<{ ok: true }>(paths.todoComplete(), { reminderId }),
            requestAccess: () =>
                post<{ granted?: boolean } & Record<string, unknown>>(paths.todosRequestAccess(), {}),
        },
    };
}

export type DashboardClient = ReturnType<typeof createDashboardClient>;
