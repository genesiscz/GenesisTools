import type { AgentStopInput, AgentStopReceiptDto, AgentsBoardDto } from "@app/dev-dashboard/contract/agents";
import type { GateLedgerDto, GateRaiseReceiptDto } from "@app/dev-dashboard/contract/gates";

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

export type EndpointMethod = "GET" | "POST" | "DELETE";

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
    /** Answers one decision letter from a stored act token (the Telegram button, a banner, the phone). */
    act: row<Record<string, never>, ActReceiptDto>("POST", "/api/act", "act"),

    // Pending ask forms.
    qaPending: row<Record<string, never>, unknown>("GET", "/api/qa/pending", "read"),
    qaPendingGet: row<{ id: string }, unknown>("GET", "/api/qa/pending/:id", "read"),
    qaPendingAnswer: row<{ id: string; answers: PendingAnswerDto[] }, { ok: boolean; entryId?: string }>(
        "POST",
        "/api/qa/pending/:id/answer",
        "keyed-write"
    ),
    qaPendingWait: row<{ id: string }, unknown>("POST", "/api/qa/pending/:id/wait", "read", "stream"),
    qaStream: row<Record<string, never>, never>("GET", "/api/qa/stream", "read", "stream"),

    // Handoffs.
    handoffLog: row<Record<string, never>, unknown>("GET", "/api/handoff/log", "read"),
    handoffGet: row<{ id: string }, unknown>("GET", "/api/handoff/get", "read"),
    handoffAction: row<Record<string, unknown>, unknown>("POST", "/api/handoff/action", "keyed-write"),

    // AI accounts.
    aiAccounts: row<Record<string, never>, unknown>("GET", "/api/ai/accounts", "read"),
    aiUsage: row<{ providers?: string; accounts?: string }, unknown>("GET", "/api/ai/usage", "read"),
    aiUsageRefresh: row<Record<string, never>, unknown>("POST", "/api/ai/usage/refresh", "keyed-write"),
    aiUsageSeries: row<Record<string, string | undefined>, unknown>("GET", "/api/ai/usage/series", "read"),
    aiSpendTotals: row<Record<string, string | undefined>, unknown>("GET", "/api/ai/spend/totals", "read", "scan"),
    aiSpendSeries: row<Record<string, string | undefined>, unknown>("GET", "/api/ai/spend/series", "read", "scan"),
    claudeUsageTotals: row<Record<string, string | undefined>, unknown>(
        "GET",
        "/api/claude/usage/totals",
        "read",
        "scan"
    ),

    // The long-running reads the proxy gave a longer deadline before this table.
    ports: row<Record<string, never>, unknown>("GET", "/api/ports", "read", "slow"),
    pulse: row<Record<string, never>, unknown>("GET", "/api/system/pulse", "read", "slow"),
    pulseHistory: row<{ metric: string; minutes: number }, unknown>("GET", "/api/system/pulse/history", "read", "slow"),
    tmuxSessions: row<{ include?: string }, unknown>("GET", "/api/tmux/sessions", "read", "slow"),
    live: row<Record<string, never>, never>("GET", "/api/live", "read", "stream"),
    daemonRunsTail: row<Record<string, string | undefined>, never>("GET", "/api/daemon/runs/tail", "read", "stream"),

    // The Mac gateway: one row per hub capability (`src/hub/lib/capabilities`), plus the one upload route.
    gatewayAgents: row<GatewayInput, unknown>("GET", "/api/gateway/agents", "read", "slow"),
    gatewayTranscript: row<GatewayInput, unknown>("GET", "/api/gateway/transcript", "read", "slow"),
    gatewayProcs: row<GatewayInput, unknown>("GET", "/api/gateway/procs", "read", "slow"),
    gatewayStuck: row<GatewayInput, unknown>("GET", "/api/gateway/stuck", "read"),
    gatewayForecast: row<GatewayInput, unknown>("GET", "/api/gateway/forecast", "read"),
    gatewayPrompts: row<GatewayInput, unknown>("GET", "/api/gateway/prompts", "read"),
    gatewayWidgetSnapshot: row<GatewayInput, unknown>("GET", "/api/gateway/widget-snapshot", "read", "slow"),
    gatewayUpload: row<Record<string, never>, UploadReceipt>("POST", "/api/gateway/upload", "keyed-write"),
    /** The agents board (F9): every live session with its phase, project, account, model, prompt and sub-agents. */
    gatewayBoard: row<GatewayInput, AgentsBoardDto>("GET", "/api/gateway/board", "read", "slow"),
    /**
     * Ends one live session's process tree (F19). A keyed write behind the full login, not the act scope: an act token
     * alone answers one decision letter, and ending a process needs more than that (`src/hub/lib/board/stop.ts`).
     */
    agentsStop: row<AgentStopInput, AgentStopReceiptDto>("POST", "/api/agents/stop", "keyed-write"),
    /** What waits on the Mac's Touch ID (F22): vault and AI account windows, rm requests, and the latest decisions. */
    gatewayGates: row<GatewayInput, GateLedgerDto>("GET", "/api/gateway/gates", "read"),
    /** Brings one waiting gate to the Mac's front, or opens the window of an rm request that has none (F22). */
    gatesRaise: row<{ id: string }, GateRaiseReceiptDto>("POST", "/api/gates/raise", "keyed-write"),
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
