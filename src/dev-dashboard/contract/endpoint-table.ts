import type {
    AgentInterruptInput,
    AgentInterruptReceiptDto,
    AgentSendInput,
    AgentSendReceiptDto,
    AgentStopInput,
    AgentStopReceiptDto,
    AgentsBoardDto,
    AgentVoiceReceiptDto,
    PrChecksDto,
    PreparedPromptDto,
    PrFixInput,
    PrFixReceiptDto,
    PrMergeInput,
    PrMergeReceiptDto,
    PrTriageDto,
} from "@app/dev-dashboard/contract/agents";
import type {
    AiAccountsResult,
    AiDaemonStatus,
    AiSpendSeriesResult,
    AiSpendTotalsResult,
    AiUsageResult,
    AiUsageSeriesResult,
} from "@app/dev-dashboard/contract/ai-accounts";
import type {
    ApprovalAnswerInput,
    ApprovalReceiptDto,
    PendingApprovalsDto,
} from "@app/dev-dashboard/contract/approvals";
import type { MorningBriefDto } from "@app/dev-dashboard/contract/brief";
import type {
    AttachTmuxResult,
    ContainersResult,
    DaemonOverview,
    DashboardSendTarget,
    DiskUsageResult,
    FocusSessionResultDto,
    HandoffActionInput,
    HandoffActionResponse,
    HandoffEventsResponse,
    HandoffGetResponse,
    HandoffListResponse,
    HandoffPostResponse,
    HandoffTarget,
    HandoffTaskInput,
    KillPortResult,
    LogEntry,
    ProcessSort,
    PublicHandoff,
    PublishedNote,
    QaRow,
    RunSummary,
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
    NetStatusRes,
    ObsidianNoteRes,
    ObsidianTreeRes,
    PortsRes,
    ProcessesRes,
    PulseHistoryRes,
    PulseRes,
    QaLogRes,
    TimelineRes,
    TmuxPresetRestoreRes,
    TmuxPresetSaveRes,
    TmuxPresetsRes,
    TmuxSessionsRes,
    TodosRes,
    TtydListRes,
    WeatherRes,
} from "@app/dev-dashboard/contract/endpoints";
import type { GateLedgerDto, GateRaiseReceiptDto } from "@app/dev-dashboard/contract/gates";
import type { ForecastDto, GlanceDto } from "@app/dev-dashboard/contract/glance";
import type { AgentNewInput, AgentNewReceiptDto, LaunchOptionsDto } from "@app/dev-dashboard/contract/launch";
import type { LiveAskForm, LiveChannel, LiveSubscribeBody } from "@app/dev-dashboard/contract/live";
import type { MemoActInput, MemoActReceiptDto, MemosDto } from "@app/dev-dashboard/contract/memos";
import type { PingWatchesDto, PingWatchInput } from "@app/dev-dashboard/contract/ping";
import type { PushDeviceReceipt, PushDeviceRegistration } from "@app/dev-dashboard/contract/push";
import type { SnapInput, SnapReceiptDto } from "@app/dev-dashboard/contract/snap";
import type {
    TimesheetFillInput,
    TimesheetFillReceiptDto,
    TimesheetWeekDto,
} from "@app/dev-dashboard/contract/timesheet";
import type {
    VaultAppendInput,
    VaultAppendReceiptDto,
    VaultClipInput,
    VaultClipReceiptDto,
} from "@app/dev-dashboard/contract/vault";
import type { HealthDto, WakeRelayDto } from "@app/dev-dashboard/contract/wake";
import type { WatchingDto, WatchMuteInput, WatchMuteReceiptDto } from "@app/dev-dashboard/contract/watching";

/**
 * The endpoint table: one row per non-board endpoint the phone and the web reach. The server binds a row
 * (`server/bind.ts`), the front proxy reads its timeout tier, and one generic client method calls any row
 * (`client.call(ENDPOINTS.<name>, input)`). Pure data and types: no zod, no server import, so the phone bundle may
 * import it (`contract-purity.test.ts`). The 57 board routes stay out of it.
 *
 * The wire types below are written here, not imported from the question lib: a type import of a server module made
 * the phone's `tsc` walk the whole server tree (`question/lib/inbox` reaches git, transclusion and zstd code).
 * `bind.test.ts` pins that the server's answers still fit them.
 */

/**
 * What a call may do, and so what auth it needs. `read` changes nothing. `keyed-write` changes durable state and is
 * replayed safely: a retried request with the same `Idempotency-Key` gets the first answer. `act` answers one thing
 * from a stored token; the auth guard lets it through on the token alone (`x-gt-act-token`).
 */
export type PolicyClass = "read" | "keyed-write" | "act";

/** The front proxy's upstream deadline: 15 s, 60 s, 120 s, or none for a stream. */
export type TimeoutTier = "default" | "slow" | "scan" | "stream";

export const TIMEOUT_TIER_MS: Readonly<Record<TimeoutTier, number | undefined>> = {
    default: 15_000,
    slow: 60_000,
    scan: 120_000,
    stream: undefined,
};

export type EndpointMethod = "GET" | "POST" | "PATCH" | "DELETE";

/**
 * One endpoint. `I` is the input (path params, then query for GET, else the JSON body); `O` the JSON answer. The
 * `io` member is a phantom: it is never set, it only carries the two types to `client.call`.
 */
export interface Endpoint<I = unknown, O = unknown> {
    method: EndpointMethod;
    /** The router pattern, `:name` for a path segment. */
    path: string;
    policy: PolicyClass;
    timeout: TimeoutTier;
    readonly io?: { readonly input: I; readonly output: O };
}

export type EndpointInput<E> = E extends { readonly io?: { readonly input: infer I } } ? I : never;
export type EndpointOutput<E> = E extends { readonly io?: { readonly output: infer O } } ? O : never;

function row<I, O>(method: EndpointMethod, path: string, policy: PolicyClass, timeout: TimeoutTier = "default") {
    return { method, path, policy, timeout } as Endpoint<I, O>;
}

/** One answer of a batch, as `tools question inbox answer --batch` takes it. */
export interface DecisionAnswerInput {
    number: number;
    option?: string;
    text?: string;
    /** The revision the caller showed; a newer post refuses the answer. */
    expectedRevision?: number;
}

/** A capability of the Mac gateway (`src/hub/lib/capabilities`), reached over HTTP with its own input check. */
export type GatewayInput = Record<string, string | number | boolean | string[] | undefined>;

export interface UploadReceipt {
    /** Absolute path on the Mac; the phone hands it to an agent or the widget shelf. */
    path: string;
    bytes: number;
    sha256: string;
    contentType: string;
}

/** A stored decision as the routes answer it: the fields every surface reads (the wire carries more). */
export interface DecisionRowDto {
    id: string;
    sessionId: string;
    number: number;
    prompt: string;
    options: string[];
    state: string;
    revision?: number;
    option?: string;
    answer?: string;
    title?: string;
    project?: string;
    recommended?: string;
}

/** The answer of a decision write that delivers (`InboxAnswerResult` in `question/lib/inbox/answer.ts`). */
export interface DecisionDeliveryDto {
    session: string | null;
    text: string;
    channel: string;
    delivered: boolean;
    uncertain?: boolean;
    detail?: string;
    target?: string;
    error?: string;
    queueId?: string;
    queueTextHash?: string;
}

/** A re-send of queued answers (`SendResult` in `question/lib/decisions/send.ts`). */
export interface DecisionSendDto {
    text?: string;
    numbers?: number[];
    channel?: string;
    delivered?: boolean;
    uncertain?: boolean;
    target?: string;
    error?: string;
}

/** The closed outcome of an act (`ActReceipt` in `question/lib/act/act.ts`). */
export interface ActReceiptDto {
    key: string;
    outcome:
        | { kind: "delivered" | "queued" | "uncertain"; detail?: string }
        | { kind: "refused"; code: "unknown-token" | "expired" | "closed" | "changed" | "invalid"; detail: string };
    decision?: { id: string; session: string; number: number; option: string };
    at: number;
}

/** One option of a waiting item, as the hub inbox shows it. */
export interface WaitingChoiceDto {
    id: string;
    label: string;
    rationale: string | null;
    recommended: boolean;
}

/** A decision of the answer queue (`InboxDecision` in `question/lib/inbox/build.ts`; the wire carries more). */
export interface WaitingDecisionDto {
    kind: "decision";
    id: string;
    number: number;
    title: string | null;
    prompt: string;
    choices: WaitingChoiceDto[];
    recommended: string | null;
    /** The user may pick several letters; the staged `option` is then a set such as `ac`. */
    multiple: boolean;
    blocking: boolean;
    /** `waiting` or `drafted`; a staged pick or note is `drafted`. */
    status: string;
    context: string | null;
    proposal: string | null;
    reasoning: string | null;
    /** The staged pick (option letters) and note, not sent yet. */
    draftOption: string | null;
    draft: string | null;
    /** The revision the phone shows; a stage or a send passes it back as `expectedRevision`. */
    revision: number;
    at: string;
}

/** One question of a pending ask form (`InboxQuestion`). */
export interface WaitingQuestionDto {
    itemId: string;
    prompt: string;
    choices: WaitingChoiceDto[];
    multiple: boolean;
    freeText: boolean;
    required: boolean;
}

/** A pending ask form of the answer queue (`InboxForm`). */
export interface WaitingFormDto {
    kind: "form";
    id: string;
    source: string | null;
    cwd: string;
    questions: WaitingQuestionDto[];
    at: string;
}

/** An agent's own question dialog (a plan approval, a permission prompt); the phone shows it, the Mac answers it. */
export interface WaitingDialogDto {
    kind: "dialog";
    id: string;
    title: string;
    prompt: string;
    choices: WaitingChoiceDto[];
    at: string;
}

export type WaitingItemDto = WaitingDecisionDto | WaitingFormDto | WaitingDialogDto;

export interface WaitingSessionDto {
    /** The agent session; null for a form no session posted. */
    sessionId: string | null;
    provider: string | null;
    title: string | null;
    project: string | null;
    /** The items that count in the badges, as the notch counts them. */
    counted: number;
    /** Newest ask first. */
    items: WaitingItemDto[];
}

/** The answer queue (`WaitingQueue` in `question/lib/inbox/load.ts`): the waiting set grouped by session. */
export interface WaitingQueueDto {
    /** The badge number, equal to the notch widget's. */
    total: number;
    sessions: WaitingSessionDto[];
    at: string;
}

/** One sound of `GET /api/qa/audio-library` (`AudioLibraryEntry` in `@genesiscz/utils/audio/library`). */
export interface QaAudioEntryDto {
    id: string;
    label: string;
    kind: "bundled" | "synth";
    isDefault: boolean;
}

/** The sounds the QA ding may play, and the default one. */
export interface QaAudioLibraryDto {
    bundled: QaAudioEntryDto[];
    synth: QaAudioEntryDto[];
    default: QaAudioEntryDto;
}

/** One answer of a pending ask form, as `POST /api/qa/pending/:id/answer` takes it. */
export interface PendingAnswerDto {
    itemId: string;
    selectedChoices?: string[];
    freeText?: string;
}

export const ENDPOINTS = {
    // Decisions (the hub inbox), the same doors as `tools question inbox`.
    qaDecisions: row<{ hours?: number }, unknown>("GET", "/api/qa/decisions", "read"),
    /** The phone's answer queue: everything the waiting set says waits, grouped by session, with the notch counts. */
    qaWaiting: row<{ hours?: number }, WaitingQueueDto>("GET", "/api/qa/waiting", "read"),
    qaDecisionsSession: row<{ id: string }, { sessionId: string; decisions: unknown[] }>(
        "GET",
        "/api/qa/decisions/session/:id",
        "read"
    ),
    qaDecisionsAnswer: row<
        { session: string; answers: DecisionAnswerInput[]; provider?: string; cwd?: string; dryRun?: boolean },
        DecisionDeliveryDto
    >("POST", "/api/qa/decisions/answer", "keyed-write"),
    qaDecisionsSend: row<{ session: string; provider?: string }, DecisionSendDto>(
        "POST",
        "/api/qa/decisions/send",
        "keyed-write"
    ),
    qaDecisionsDraft: row<
        {
            session: string;
            number: number;
            option?: string;
            text?: string;
            provider?: string;
            cwd?: string;
            expectedRevision?: number;
        },
        DecisionRowDto
    >("POST", "/api/qa/decisions/draft", "keyed-write"),
    qaDecisionsDismiss: row<{ session: string; number: number; expectedRevision?: number }, DecisionRowDto>(
        "POST",
        "/api/qa/decisions/dismiss",
        "keyed-write"
    ),
    qaDecisionsSendDrafts: row<
        {
            session: string;
            provider?: string;
            dryRun?: boolean;
            /** Only the drafts of these decisions, at the revision the caller shows; absent: every draft. */
            drafts?: Array<{ number: number; expectedRevision?: number }>;
        },
        DecisionSendDto
    >("POST", "/api/qa/decisions/send-drafts", "keyed-write"),
    /**
     * Answers one decision letter from a stored act token (the Telegram button, a banner, the phone). A reply token
     * (the lock screen's Reply field) answers with `text`.
     */
    act: row<{ text?: string }, ActReceiptDto>("POST", "/api/act", "act"),

    // Pending ask forms.
    qaPending: row<{ ids?: string }, { forms: LiveAskForm[] }>("GET", "/api/qa/pending", "read"),
    qaPendingGet: row<{ id: string }, { form: LiveAskForm }>("GET", "/api/qa/pending/:id", "read"),
    qaPendingAnswer: row<{ id: string; answers: PendingAnswerDto[] }, { ok: boolean; entryId?: string }>(
        "POST",
        "/api/qa/pending/:id/answer",
        "keyed-write"
    ),
    qaPendingWait: row<{ id: string }, unknown>("POST", "/api/qa/pending/:id/wait", "read", "stream"),
    qaStream: row<Record<string, never>, never>("GET", "/api/qa/stream", "read", "stream"),

    // Handoffs.
    handoffLog: row<{ limit?: number }, HandoffListResponse>("GET", "/api/handoff/log", "read"),
    handoffGet: row<{ id: string }, HandoffGetResponse>("GET", "/api/handoff/get", "read"),
    handoffAction: row<{ id: string; actions: HandoffActionInput[] }, HandoffActionResponse>(
        "POST",
        "/api/handoff/action",
        "keyed-write"
    ),

    // AI accounts.
    aiAccounts: row<Record<string, never>, AiAccountsResult>("GET", "/api/ai/accounts", "read"),
    aiUsage: row<{ providers?: string; accounts?: string }, AiUsageResult>("GET", "/api/ai/usage", "read"),
    aiUsageRefresh: row<Record<string, never>, AiUsageResult>("POST", "/api/ai/usage/refresh", "keyed-write"),
    aiUsageSeries: row<Record<string, string | undefined>, AiUsageSeriesResult>("GET", "/api/ai/usage/series", "read"),
    aiSpendTotals: row<Record<string, string | undefined>, AiSpendTotalsResult>(
        "GET",
        "/api/ai/spend/totals",
        "read",
        "scan"
    ),
    aiSpendSeries: row<Record<string, string | undefined>, AiSpendSeriesResult>(
        "GET",
        "/api/ai/spend/series",
        "read",
        "scan"
    ),
    claudeUsageTotals: row<Record<string, string | undefined>, AiSpendTotalsResult>(
        "GET",
        "/api/claude/usage/totals",
        "read",
        "scan"
    ),

    // The long-running reads the proxy gave a longer deadline before this table.
    ports: row<Record<string, never>, PortsRes>("GET", "/api/ports", "read", "slow"),
    pulse: row<Record<string, never>, PulseRes>("GET", "/api/system/pulse", "read", "slow"),
    pulseHistory: row<{ metric: string; minutes: number }, PulseHistoryRes>(
        "GET",
        "/api/system/pulse/history",
        "read",
        "slow"
    ),
    tmuxSessions: row<{ include?: string }, TmuxSessionsRes>("GET", "/api/tmux/sessions", "read", "slow"),
    live: row<Record<string, never>, never>("GET", "/api/live", "read", "stream"),
    daemonRunsTail: row<Record<string, string | undefined>, never>("GET", "/api/daemon/runs/tail", "read", "stream"),

    // The Mac gateway: one row per hub capability (`src/hub/lib/capabilities`), plus the one upload route.
    gatewayAgents: row<GatewayInput, unknown>("GET", "/api/gateway/agents", "read", "slow"),
    gatewayTranscript: row<GatewayInput, unknown>("GET", "/api/gateway/transcript", "read", "slow"),
    gatewayProcs: row<GatewayInput, unknown>("GET", "/api/gateway/procs", "read", "slow"),
    gatewayStuck: row<GatewayInput, unknown>("GET", "/api/gateway/stuck", "read"),
    gatewayForecast: row<GatewayInput, ForecastDto>("GET", "/api/gateway/forecast", "read"),
    gatewayPrompts: row<GatewayInput, unknown>("GET", "/api/gateway/prompts", "read"),
    /** PR triage (F20): the open PRs with readiness, and one PR's checks with the failing step's log tail. */
    gatewayPrs: row<GatewayInput, PrTriageDto>("GET", "/api/gateway/prs", "read", "slow"),
    gatewayPrChecks: row<GatewayInput, PrChecksDto>("GET", "/api/gateway/pr-checks", "read", "slow"),
    /** Hands a PR's threads or one failed check to the session that owns the PR (F20). */
    prsFix: row<PrFixInput, PrFixReceiptDto>("POST", "/api/prs/fix", "keyed-write", "slow"),
    /** Merges a PR (`tools github merge --rebase|--squash`); the phone asks for Face ID first (F20). */
    prsMerge: row<PrMergeInput, PrMergeReceiptDto>("POST", "/api/prs/merge", "keyed-write", "slow"),
    /** One saved prompt rendered for one session, each variable with its value and source (F23). */
    gatewayPromptPrepare: row<GatewayInput, PreparedPromptDto>("GET", "/api/gateway/prompt-prepare", "read", "slow"),
    gatewayWidgetSnapshot: row<GatewayInput, unknown>("GET", "/api/gateway/widget-snapshot", "read", "slow"),
    gatewayUpload: row<Record<string, never>, UploadReceipt>("POST", "/api/gateway/upload", "keyed-write"),
    /** The agents board (F9): every live session with its phase, project, account, model, prompt and sub-agents. */
    gatewayBoard: row<GatewayInput, AgentsBoardDto>("GET", "/api/gateway/board", "read", "slow"),
    /**
     * Ends one live session's process tree (F19). A keyed write behind the full login, not the act scope: an act token
     * alone answers one decision letter, and ending a process needs more than that (`src/hub/lib/board/stop.ts`).
     */
    agentsStop: row<AgentStopInput, AgentStopReceiptDto>("POST", "/api/agents/stop", "keyed-write"),

    // Push to the phone (F2): a device registers its APNs token or simulator id and its box key on every start.
    pushRegister: row<PushDeviceRegistration, PushDeviceReceipt>("POST", "/api/push/devices", "keyed-write"),
    pushUnregister: row<{ id: string }, { removed: boolean }>("DELETE", "/api/push/devices/:id", "keyed-write"),
    /** One test notice to the calling device, with two answer buttons that answer nothing real. */
    pushTest: row<{ id: string }, { ok: boolean; detail?: string }>("POST", "/api/push/test", "keyed-write"),
    /**
     * One message into a live session at a timing (M5, F10). A keyed write behind the full login: the key is the
     * durable queue's idempotency key, so a replayed send (an offline draft sent twice) is one delivery.
     */
    agentsSend: row<AgentSendInput, AgentSendReceiptDto>("POST", "/api/agents/send", "keyed-write", "slow"),
    /** A walkie-talkie clip as the raw body, kept and transcribed on the Mac (F12); nothing is sent to a session. */
    agentsVoice: row<Record<string, never>, AgentVoiceReceiptDto>("POST", "/api/agents/voice", "keyed-write", "slow"),
    /** Ends a live session's running turn with its TUI's Esc key (F19); refused while a dialog is open. */
    agentsInterrupt: row<AgentInterruptInput, AgentInterruptReceiptDto>("POST", "/api/agents/interrupt", "keyed-write"),
    /** What waits on the Mac's Touch ID (F22): vault and AI account windows, rm requests, and the latest decisions. */
    gatewayGates: row<GatewayInput, GateLedgerDto>("GET", "/api/gateway/gates", "read"),
    /** Brings one waiting gate to the Mac's front, or opens the window of an rm request that has none (F22). */
    gatesRaise: row<{ id: string }, GateRaiseReceiptDto>("POST", "/api/gates/raise", "keyed-write"),
    /** Tool calls that wait for allow or deny (M9, F8): pane permission and plan dialogs, codex worker requests. */
    gatewayApprovals: row<GatewayInput, PendingApprovalsDto>("GET", "/api/gateway/approvals", "read", "slow"),
    /**
     * Allows or denies one waiting tool call (F8). A keyed write behind the full login, not the act scope: an act token
     * answers one decision letter, and an allow runs a command on the Mac. The phone asks for Face ID before an allow.
     */
    /**
     * The phone's glance (F13, F16, F17, F18): the waiting count, the fleet, the newest decisions and the closest limit,
     * read by the icon badge, the Lock Screen widgets and the fleet Live Activity. Read only.
     */
    gatewayGlance: row<GatewayInput, GlanceDto>("GET", "/api/gateway/glance", "read", "slow"),
    /** The sessions the Mac watches for "ping me when done" (F15). */
    gatewayPings: row<GatewayInput, PingWatchesDto>("GET", "/api/gateway/pings", "read"),
    /** Watch one live session by its board key; the Mac pushes once when its turn ends (F15). */
    pingWatch: row<PingWatchInput, PingWatchesDto>("POST", "/api/ping/watch", "keyed-write"),
    /** Stop watching one session (F15). */
    pingUnwatch: row<{ key: string }, PingWatchesDto>("POST", "/api/ping/unwatch", "keyed-write"),
    approvalsAnswer: row<ApprovalAnswerInput, ApprovalReceiptDto>(
        "POST",
        "/api/approvals/answer",
        "keyed-write",
        "slow"
    ),
    /** The New agent sheet (F21): harnesses, accounts ranked by headroom from cached readings, and repos. */
    gatewayLaunch: row<GatewayInput, LaunchOptionsDto>("GET", "/api/gateway/launch", "read"),
    /** Starts an agent in a background cmux workspace (`tools cmux agents new`, F21). */
    agentsNew: row<AgentNewInput, AgentNewReceiptDto>("POST", "/api/agents/new", "keyed-write", "slow"),
    /** Every watch on the Mac in one list (F30): Monitor, domains, shops, TradingView. */
    gatewayWatching: row<GatewayInput, WatchingDto>("GET", "/api/gateway/watching", "read", "slow"),
    /** Silences one watch for a while (Monitor watchers; the other sources answer that they have no mute). */
    watchingMute: row<WatchMuteInput, WatchMuteReceiptDto>("POST", "/api/watching/mute", "keyed-write"),
    /** The stored morning brief (F29); null before the daemon task first built it. Asks Waze nothing. */
    gatewayBrief: row<GatewayInput, MorningBriefDto | null>("GET", "/api/gateway/brief", "read"),
    /** The wakeup relay this Mac is registered with (F26): the phone keeps it to wake the Mac while it sleeps. */
    gatewayWake: row<GatewayInput, WakeRelayDto>("GET", "/api/gateway/wake", "read"),
    /** Answers while the server runs: the phone's probe after a wake (F26). */
    health: row<Record<string, never>, HealthDto>("GET", "/api/health", "read"),
    /** One Clarity week for the Friday swipe (F27): tasks, minutes per day, unmapped time and its revision. */
    gatewayTimesheet: row<GatewayInput, TimesheetWeekDto | null>("GET", "/api/gateway/timesheet", "read", "slow"),
    /** Writes the week into Clarity when it still matches the revision the phone showed (F27). */
    timesheetFill: row<TimesheetFillInput, TimesheetFillReceiptDto>(
        "POST",
        "/api/timesheet/fill",
        "keyed-write",
        "slow"
    ),
    /** Clips a link into the vault inbox: a page as Markdown, a video queued for transcription (F25). */
    vaultClip: row<VaultClipInput, VaultClipReceiptDto>("POST", "/api/vault/clip", "keyed-write", "slow"),
    /** Appends text to a vault note, the inbox note of the day by default (F25, F28). */
    vaultAppend: row<VaultAppendInput, VaultAppendReceiptDto>("POST", "/api/vault/append", "keyed-write"),
    /** Puts an uploaded photo onto the widget shelf and into a session's draft (F24). */
    snap: row<SnapInput, SnapReceiptDto>("POST", "/api/snap", "keyed-write"),
    /** Voice Memos turned into todos, a note and an agent task (F28). */
    gatewayMemos: row<GatewayInput, MemosDto>("GET", "/api/gateway/memos", "read"),
    /** Runs one action of a memo once: Reminders, the vault note, or a session (F28). */
    memosAct: row<MemoActInput, MemoActReceiptDto>("POST", "/api/memos/act", "keyed-write", "slow"),
    // The rest of the dashboard's own routes (C30): each was a pattern literal in its route file. The handlers stay
    // written by hand; `server/bind.ts` (`bindHandler`) takes the method, the pattern and the tier from the row.
    netStatus: row<Record<string, never>, NetStatusRes>("GET", "/api/net/status", "read"),
    weather: row<Record<string, never>, WeatherRes>("GET", "/api/weather", "read"),
    tmuxCreate: row<
        { name?: string; cwd?: string; command?: string },
        { sessionName: string; cwd: string; command: string }
    >("POST", "/api/tmux/create", "keyed-write"),
    tmuxRename: row<{ from: string; to: string }, { sessionName: string }>("POST", "/api/tmux/rename", "keyed-write"),
    tmuxPresets: row<Record<string, never>, TmuxPresetsRes>("GET", "/api/tmux/presets", "read"),
    tmuxPresetSave: row<{ name: string; note?: string; prefix?: string }, TmuxPresetSaveRes>(
        "POST",
        "/api/tmux/presets/save",
        "keyed-write"
    ),
    tmuxPresetRestore: row<{ name: string }, TmuxPresetRestoreRes>("POST", "/api/tmux/presets/restore", "keyed-write"),
    tmuxPresetDelete: row<{ name: string }, { removed: boolean }>("DELETE", "/api/tmux/presets", "keyed-write"),
    ttydList: row<Record<string, never>, TtydListRes>("GET", "/api/ttyd/list", "read"),
    ttydSpawn: row<{ command?: string; cwd?: string; tmuxSessionName?: string }, { session: TtydSession }>(
        "POST",
        "/api/ttyd/spawn",
        "keyed-write"
    ),
    ttydKill: row<{ id: string; killTmux?: boolean }, { ok: boolean }>("POST", "/api/ttyd/kill", "keyed-write"),
    ttydRename: row<{ id: string; name: string }, { ok: boolean }>("POST", "/api/ttyd/rename", "keyed-write"),
    cmuxSnapshot: row<Record<string, never>, CmuxSnapshotRes>("GET", "/api/cmux/snapshot", "read"),
    cmuxLayout: row<Record<string, never>, CmuxLayoutRes>("GET", "/api/cmux/layout", "read"),
    cmuxCreateTerminal: row<{ cwd?: string }, { result: AttachTmuxResult }>(
        "POST",
        "/api/cmux/create-terminal",
        "keyed-write"
    ),
    cmuxCreateWorkspace: row<
        { windowId: string; name?: string; cwd?: string },
        { result: { workspaceId: string; windowId: string } }
    >("POST", "/api/cmux/create-workspace", "keyed-write"),
    cmuxSendSession: row<
        { tmuxSessionName: string; target: DashboardSendTarget; cwd?: string },
        { result: AttachTmuxResult }
    >("POST", "/api/cmux/send-session", "keyed-write"),
    cmuxRemoveSession: row<{ tmuxSessionName: string }, { removed: number }>(
        "POST",
        "/api/cmux/remove-session",
        "keyed-write"
    ),
    cmuxAttach: row<{ workspaceId: string; paneId: string }, { ok: boolean }>(
        "POST",
        "/api/cmux/attach",
        "keyed-write"
    ),
    cmuxRename: row<{ workspaceId: string; surfaceId?: string; title: string }, { ok: boolean }>(
        "POST",
        "/api/cmux/rename",
        "keyed-write"
    ),
    /** Focuses the cmux pane a session lives in; a miss is a 409 with the same body shape. */
    cmuxFocusSession: row<{ sessionId: string }, FocusSessionResultDto>(
        "POST",
        "/api/cmux/focus-session",
        "keyed-write"
    ),
    commands: row<Record<string, never>, CommandsRes>("GET", "/api/commands", "read"),
    commandsCreate: row<SavedCommandInput, { command: SavedCommand }>("POST", "/api/commands", "keyed-write"),
    commandsDelete: row<{ id: string }, { removed: number }>("DELETE", "/api/commands", "keyed-write"),
    aiDaemon: row<Record<string, never>, AiDaemonStatus>("GET", "/api/ai/daemon", "read"),
    aiDaemonRegister: row<Record<string, never>, { ok: boolean }>("POST", "/api/ai/daemon/register", "keyed-write"),
    claudeUsage: row<Record<string, never>, AiUsageResult>("GET", "/api/claude/usage", "read"),
    claudeUsageHistory: row<
        { account?: string; buckets?: string; bucket?: string; minutes?: number },
        AiUsageSeriesResult
    >("GET", "/api/claude/usage/history", "read"),
    daemonStatus: row<Record<string, never>, DaemonOverview>("GET", "/api/daemon/status", "read"),
    daemonRuns: row<{ task?: string; limit?: number }, RunSummary[]>("GET", "/api/daemon/runs", "read"),
    daemonRunLog: row<{ logFile: string }, LogEntry[]>("GET", "/api/daemon/runs/log", "read"),
    timeline: row<{ since?: number }, TimelineRes>("GET", "/api/timeline", "read"),
    containers: row<Record<string, never>, ContainersResult>("GET", "/api/containers", "read"),
    diskUsage: row<Record<string, never>, DiskUsageResult>("GET", "/api/disk/usage", "read"),
    portsKill: row<{ pid: number; expectedCommand?: string }, KillPortResult>("POST", "/api/ports/kill", "keyed-write"),
    /** Changes the channel set of one open `/api/live` connection. */
    liveSubscribe: row<LiveSubscribeBody, { ok: true; channels: LiveChannel[] }>(
        "POST",
        "/api/live/subscribe",
        "keyed-write"
    ),
    processes: row<{ sort?: ProcessSort; limit?: number }, ProcessesRes>("GET", "/api/processes", "read"),
    /** `command` is required: the server compares it with the live name, so a reissued pid is never signalled. */
    processesKill: row<{ pid: number; command: string }, { ok: boolean }>("POST", "/api/processes/kill", "keyed-write"),
    qaLog: row<{ project?: string; tag?: string; unread?: "1"; limit?: number }, QaLogRes>(
        "GET",
        "/api/qa/log",
        "read"
    ),
    /** The unclipped entry: `/api/qa/log` clips answers over `QA_ANSWER_MAX_CHARS`. */
    qaEntry: row<{ id: string }, { entry: QaRow }>("GET", "/api/qa/entry/:id", "read"),
    qaRead: row<{ ids: string[]; unread?: boolean }, { ok: boolean; updated: number }>(
        "POST",
        "/api/qa/read",
        "keyed-write"
    ),
    qaAudioLibrary: row<Record<string, never>, QaAudioLibraryDto>("GET", "/api/qa/audio-library", "read"),
    /** The sound file itself (audio bytes, not JSON): read through `client.url`, never `call`. */
    qaSound: row<{ id: string }, never>("GET", "/api/qa/sound", "read"),
    qaConfig: row<{ sound?: string; soundVolume?: number }, { ok: boolean; output: string }>(
        "POST",
        "/api/qa/config",
        "keyed-write"
    ),
    /** Posts a pending ask form (the Genesis.app and `tools question ask` door); answers 201. */
    qaPendingPost: row<Record<string, unknown>, { form: LiveAskForm }>("POST", "/api/qa/pending", "keyed-write"),
    qaPendingCancel: row<{ id: string }, { form: LiveAskForm }>("DELETE", "/api/qa/pending/:id", "keyed-write"),
    qaSaveToObsidian: row<
        {
            entryId: string;
            relativeDir: string;
            baseName: string;
            mode?: "create" | "append";
            createDir?: boolean;
            includeFrontmatter?: boolean;
            includeQuestion?: boolean;
        },
        { path: string }
    >("POST", "/api/qa/save-to-obsidian", "keyed-write"),
    handoffEvents: row<{ id: string; limit?: number; before?: string; beforeUid?: string }, HandoffEventsResponse>(
        "GET",
        "/api/handoff/events",
        "read"
    ),
    handoffPost: row<
        {
            title: string;
            name?: string;
            description?: string;
            tasks: HandoffTaskInput[];
            target?: HandoffTarget;
            refs?: string[];
        },
        HandoffPostResponse
    >("POST", "/api/handoff/post", "keyed-write"),
    /** One file as the raw body; the query carries the handoff, the file name and the task. */
    handoffAttach: row<
        { id: string; filename?: string; taskId?: string; note?: string },
        { attachmentId: string; handoff: PublicHandoff }
    >("POST", "/api/handoff/attach", "keyed-write"),
    /** The attachment file itself (bytes, not JSON): read through `client.url`, never `call`. */
    handoffAttachment: row<{ id: string }, never>("GET", "/api/handoff/attachment", "read"),
    attention: row<Record<string, never>, AttentionRes>("GET", "/api/attention", "read"),
    todos: row<{ listIds?: string; lists?: string; includeCompleted?: "true" }, TodosRes>("GET", "/api/todos", "read"),
    todosRequestAccess: row<Record<string, never>, { authorized: boolean; status: string }>(
        "POST",
        "/api/todos/request-access",
        "keyed-write"
    ),
    todoAdd: row<
        { title: string; listName?: string; due?: string; priority?: TodoPriority; notes?: string },
        { reminderId: string }
    >("POST", "/api/todos", "keyed-write"),
    todoComplete: row<{ reminderId: string }, { ok: true }>("POST", "/api/todos/complete", "keyed-write"),
    todoUpdate: row<
        {
            reminderId: string;
            listIdentifier: string;
            title: string;
            notes?: string;
            due?: string | null;
            priority?: TodoPriority;
            url?: string;
        },
        { ok: true }
    >("PATCH", "/api/todos", "keyed-write"),
    todoDelete: row<{ reminderId: string }, { ok: true }>("DELETE", "/api/todos", "keyed-write"),
    obsidianTree: row<Record<string, never>, ObsidianTreeRes>("GET", "/api/obsidian/tree", "read"),
    obsidianMkdir: row<{ relativeDir: string }, { ok: boolean; relativeDir: string }>(
        "POST",
        "/api/obsidian/mkdir",
        "keyed-write"
    ),
    obsidianNote: row<{ path: string }, ObsidianNoteRes>("GET", "/api/obsidian/note", "read"),
    obsidianPublish: row<{ path: string }, { note: PublishedNote }>("POST", "/api/obsidian/publish", "keyed-write"),
    obsidianUnpublish: row<{ slug: string }, { remaining: PublishedNote[] }>(
        "POST",
        "/api/obsidian/unpublish",
        "keyed-write"
    ),
    /** The phone's first sealed request: proves the pairing code and stores the phone's box key. */
    e2ePair: row<{ envelope: string }, { ok: true }>("POST", "/api/e2e/pair", "keyed-write"),
} as const satisfies Record<string, Endpoint>;

export type EndpointName = keyof typeof ENDPOINTS;

/** Whether a router pattern (`/api/qa/pending/:id/wait`) matches a concrete path. */
export function pathMatches(pattern: string, pathname: string): boolean {
    const want = pattern.split("/");
    const have = pathname.split("/");

    return (
        want.length === have.length &&
        want.every((part, index) => (part.startsWith(":") ? have[index] !== "" : part === have[index]))
    );
}

/** The table row for a request, or undefined for a path the table does not hold (boards, the UI, static files). */
export function findEndpoint(method: string, pathname: string): Endpoint | undefined {
    return Object.values(ENDPOINTS).find((entry) => entry.method === method && pathMatches(entry.path, pathname));
}

/**
 * The tier of a path whatever its method (the proxy sees the path first). A path that two rows share takes the
 * longer deadline, so a stream is never cut.
 */
export function endpointTier(pathname: string): TimeoutTier | undefined {
    const order: TimeoutTier[] = ["stream", "scan", "slow", "default"];
    const tiers = Object.values(ENDPOINTS)
        .filter((entry) => pathMatches(entry.path, pathname))
        .map((entry) => entry.timeout);

    return order.find((tier) => tiers.includes(tier));
}

/** The path of a row with its `:params` filled from `input`, and the input left over (the query or the body). */
export function fillPath(
    pattern: string,
    input: Record<string, unknown>
): { path: string; rest: Record<string, unknown> } {
    const rest = { ...input };
    const path = pattern
        .split("/")
        .map((part) => {
            if (!part.startsWith(":")) {
                return part;
            }

            const name = part.slice(1);
            const value = rest[name];
            delete rest[name];

            if (value === undefined || value === "") {
                throw new Error(`${pattern}: missing path parameter ${name}`);
            }

            return encodeURIComponent(String(value));
        })
        .join("/");

    return { path, rest };
}
