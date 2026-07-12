// Pure data contract for the dev-dashboard API. Consumed by the web UI, the Agent
// (response typing), and the Expo mobile app. Everything here is TYPE-ONLY —
// `export type` re-exports erase at runtime, so this module pulls in zero runtime
// code. The contract-purity test enforces: no VALUE import from `lib/*`, and no
// `node:`/`bun:` import. Keeping it type-only is what makes it safe to bundle into
// the React Native app.

// Deferred-feature return types live outside dev-dashboard/lib; type-only re-export.
export type { AccountUsage } from "@app/claude/lib/usage/api";
export type { LogEntry, RunSummary } from "@app/daemon/lib/types";
export type { PublishedNote } from "@app/dev-dashboard/config";
export type {
    AttentionDeepLink,
    AttentionItem,
    AttentionKind,
} from "@app/dev-dashboard/lib/attention/types";
export type {
    AnnotationDto,
    AnnotationIntent,
    AnnotationStatus,
    AttemptDto,
    BoardDocDto,
    BoardEventDto,
    BoardSummaryDto,
    CardDto,
    ChoiceItemDto,
    EdgeDto,
    ListenerDto,
    MessageAttachmentDto,
    MessageDto,
    QuestionDto,
    Region,
    RevisionDto,
    SetDetailDto,
    SetFileDto,
    SetSummaryDto,
    StrokeDto,
    WaitResultDto,
    WorkItemDto,
} from "@app/dev-dashboard/lib/boards/types";
export type {
    BucketSeries,
    MultiBucketHistoryResult,
    UsageHistoryResult,
} from "@app/dev-dashboard/lib/claude-usage/types";
export type {
    AttachTmuxResult,
    CmuxLayoutTree,
    CmuxSnapshot,
    DashboardSendTarget,
} from "@app/dev-dashboard/lib/cmux/types";
export type { SavedCommand, SavedCommandInput } from "@app/dev-dashboard/lib/commands/types";
export type { ContainerInfo, ContainersResult } from "@app/dev-dashboard/lib/containers/types";
export type { LogLineClass } from "@app/dev-dashboard/lib/daemon-view/classify";
export type { ClassifiedLogEntry } from "@app/dev-dashboard/lib/daemon-view/classify-types";
export type { DaemonOverview } from "@app/dev-dashboard/lib/daemon-view/types";
export type { DiskUsageEntry, DiskUsageResult } from "@app/dev-dashboard/lib/disk/types";
export type { NetQuality, NetStatus, NetTransport } from "@app/dev-dashboard/lib/net/types";
export type { RenderedNote, VaultEntry } from "@app/dev-dashboard/lib/obsidian/types";
export type { KillPortResult, PortInfo, PortsResult } from "@app/dev-dashboard/lib/ports/types";
export type { EnrichedQaEntry, QaRow } from "@app/dev-dashboard/lib/qa-types";
export type {
    ProcessInfo,
    ProcessSort,
    PulsePoint,
    PulseSeries,
    PulseSnapshot,
    TopProcess,
} from "@app/dev-dashboard/lib/system/types";
export type { TimelineEvent, TimelineEventType } from "@app/dev-dashboard/lib/timeline/types";
export type {
    TodoGroup,
    TodoGroupBy,
    TodoPriority,
    TodoStatusFilter,
    TodosResult,
} from "@app/dev-dashboard/lib/todos/types";
export type { SplitNode, TtydSession } from "@app/dev-dashboard/lib/ttyd/types";
export type { WeatherSnapshot } from "@app/dev-dashboard/lib/weather/types";

/** Surfaced by GET /api/tmux/presets. Re-declared (NOT imported from
 * @app/utils/tmux/snapshot-store) so the contract stays node:fs-free for the RN
 * bundle — keep this structurally identical to that lib's TmuxPresetSummary. */
export interface TmuxPresetSummary {
    name: string;
    capturedAt: string;
    sessions: number;
    windows: number;
    panes: number;
    bytes: number;
    note: string | undefined;
    path: string;
}

export interface TmuxRestoreOutcome {
    name: string;
    sessionName: string;
    created: boolean;
    skipped: boolean;
    reason?: string;
}

export interface TmuxRestoreResult {
    name: string;
    created: number;
    skipped: number;
    failed: number;
    outcomes: TmuxRestoreOutcome[];
}

/** Surfaced by GET /api/tmux/sessions. Owned here (the web client defined it inline before). */
export interface TmuxHubSession {
    name: string;
    attached: number;
    windows: number;
    ttydTabIds: string[];
    canAttachInTtyd: boolean;
    cmuxSurfaces: Array<{ workspaceId: string; surfaceId: string; title: string }>;
    inCmux: boolean;
}
