import type {
    AttentionItem,
    ClassifiedLogEntry,
    CmuxLayoutTree,
    CmuxSnapshot,
    EnrichedQaEntry,
    NetStatus,
    PortsResult,
    ProcessInfo,
    ProcessSort,
    PulseSeries,
    PulseSnapshot,
    SavedCommand,
    TimelineEvent,
    TmuxHubSession,
    TmuxPresetSummary,
    TmuxRestoreResult,
    TodosResult,
    TtydSession,
    VaultEntry,
    WeatherSnapshot,
} from "@app/dev-dashboard/contract/dto";

export const QA_STREAM_PATH = "/api/qa/stream" as const;

/** Build a `?a=b&c=d` suffix from defined string params (undefined keys dropped). */
function qs(params: Record<string, string | undefined>): string {
    const sp = new URLSearchParams();

    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
            sp.set(key, value);
        }
    }

    const serialized = sp.toString();
    return serialized ? `?${serialized}` : "";
}

/** Pure path builders — no fetching. The single source of truth for every route. */
export const paths = {
    // system
    pulse: () => "/api/system/pulse",
    pulseHistory: (metric: string, minutes: number) =>
        `/api/system/pulse/history${qs({ metric, minutes: String(minutes) })}`,
    weather: () => "/api/weather",
    // net
    netStatus: () => "/api/net/status",
    // processes
    processes: (sort: ProcessSort = "rss", limit?: number) =>
        `/api/processes${qs({ sort, limit: limit ? String(limit) : undefined })}`,
    processesKill: () => "/api/processes/kill",
    // tmux
    tmuxSessions: () => "/api/tmux/sessions",
    tmuxCreate: () => "/api/tmux/create",
    tmuxRename: () => "/api/tmux/rename",
    // tmux presets
    tmuxPresets: () => "/api/tmux/presets",
    tmuxPresetSave: () => "/api/tmux/presets/save",
    tmuxPresetRestore: () => "/api/tmux/presets/restore",
    tmuxPresetDelete: () => "/api/tmux/presets",
    // ttyd
    ttydList: () => "/api/ttyd/list",
    ttydSpawn: () => "/api/ttyd/spawn",
    ttydKill: () => "/api/ttyd/kill",
    ttydRename: () => "/api/ttyd/rename",
    // cmux
    cmuxSnapshot: () => "/api/cmux/snapshot",
    cmuxLayout: () => "/api/cmux/layout",
    cmuxCreateTerminal: () => "/api/cmux/create-terminal",
    cmuxCreateWorkspace: () => "/api/cmux/create-workspace",
    cmuxSendSession: () => "/api/cmux/send-session",
    cmuxRemoveSession: () => "/api/cmux/remove-session",
    cmuxAttach: () => "/api/cmux/attach",
    cmuxRename: () => "/api/cmux/rename",
    // claude usage
    claudeUsage: () => "/api/claude/usage",
    claudeUsageHistory: (q: { account?: string; buckets?: string[]; bucket?: string; minutes?: number } = {}) =>
        `/api/claude/usage/history${qs({
            account: q.account,
            buckets: q.buckets?.length ? q.buckets.join(",") : undefined,
            bucket: q.bucket,
            minutes: q.minutes ? String(q.minutes) : undefined,
        })}`,
    // daemon
    daemonStatus: () => "/api/daemon/status",
    daemonRuns: (q: { task?: string; limit?: number } = {}) =>
        `/api/daemon/runs${qs({ task: q.task, limit: q.limit ? String(q.limit) : undefined })}`,
    daemonRunLog: (logFile: string) => `/api/daemon/runs/log${qs({ logFile })}`,
    daemonRunTail: (logFile: string) => `/api/daemon/runs/tail${qs({ logFile })}`,
    // timeline
    timeline: (q: { since?: number } = {}) => `/api/timeline${qs({ since: q.since ? String(q.since) : undefined })}`,
    // commands (quick-commands snippet library)
    commands: () => "/api/commands",
    // containers
    containers: () => "/api/containers",
    // disk
    diskUsage: () => "/api/disk/usage",
    // ports
    ports: () => "/api/ports",
    portsKill: () => "/api/ports/kill",
    // qa
    qaLog: (q: { project?: string; tag?: string; unread?: boolean; limit?: number } = {}) =>
        `/api/qa/log${qs({
            project: q.project,
            tag: q.tag,
            unread: q.unread ? "1" : undefined,
            limit: q.limit ? String(q.limit) : undefined,
        })}`,
    qaRead: () => "/api/qa/read",
    qaAudioLibrary: () => "/api/qa/audio-library",
    qaSound: (id: string) => `/api/qa/sound${qs({ id })}`,
    qaConfig: () => "/api/qa/config",
    qaSaveToObsidian: () => "/api/qa/save-to-obsidian",
    // attention
    attention: () => "/api/attention",
    // todos
    todos: (listIds: string[] = [], includeCompleted = false) =>
        `/api/todos${qs({
            listIds: listIds.length ? listIds.join(",") : undefined,
            includeCompleted: includeCompleted ? "true" : undefined,
        })}`,
    todosRequestAccess: () => "/api/todos/request-access",
    todoComplete: () => "/api/todos/complete",
    todoAdd: () => "/api/todos",
    todoUpdate: () => "/api/todos",
    todoDelete: () => "/api/todos",
    // obsidian
    obsidianTree: () => "/api/obsidian/tree",
    obsidianMkdir: () => "/api/obsidian/mkdir",
    obsidianNote: (path: string) => `/api/obsidian/note${qs({ path })}`,
    obsidianPublish: () => "/api/obsidian/publish",
    obsidianUnpublish: () => "/api/obsidian/unpublish",
} as const;

// Response type aliases for the typed client methods.
export type PulseRes = PulseSnapshot;
export type PulseHistoryRes = PulseSeries;
export type TmuxSessionsRes = { sessions: TmuxHubSession[] };
export type TmuxPresetsRes = { presets: TmuxPresetSummary[] };
export type TmuxPresetSaveRes = { preset: TmuxPresetSummary };
export type TmuxPresetRestoreRes = { result: TmuxRestoreResult };
export type TtydListRes = { sessions: TtydSession[] };
export type CmuxSnapshotRes = { snapshot: CmuxSnapshot };
export type CmuxLayoutRes = { layout: CmuxLayoutTree };
export type QaLogRes = { entries: EnrichedQaEntry[] };
export type AttentionRes = { items: AttentionItem[]; count: number };
export type ObsidianTreeRes = { entries: VaultEntry[] };
export type ObsidianNoteRes = { source: string; html: string; publishedSlug: string | null };
export type WeatherRes = WeatherSnapshot;
export type NetStatusRes = NetStatus;
export type TodosRes = TodosResult;
export type ProcessesRes = { sort: ProcessSort; processes: ProcessInfo[] };
export type PortsRes = PortsResult;
export type CommandsRes = { commands: SavedCommand[] };
export type TimelineRes = TimelineEvent[];
export type RunTailRes = ClassifiedLogEntry;
