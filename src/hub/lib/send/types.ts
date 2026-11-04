import type {
    AgentInterruptReceiptDto,
    AgentSendOutcome,
    AgentSendReceiptDto,
    AgentSendTiming,
    AgentSendTimingSupport,
} from "@app/dev-dashboard/contract/agents";
import type { AccountProviderAlias } from "@genesiscz/utils/ai/providers/alias-list";

/** When a message should reach a running session; the wire type is the contract's (`AgentSendTiming`). */
export type SendTiming = AgentSendTiming;

export const SEND_TIMINGS = ["now", "next-turn", "later"] as const satisfies readonly SendTiming[];

/** What became of a send (`AgentSendOutcome`: delivered, queued-daemon, queued-session, refused, unknown). */
export type SendOutcome = AgentSendOutcome;

/** One exact session: its harness, its native id and the home its transcript lives in. */
export interface SessionAddress {
    provider: AccountProviderAlias;
    sessionId: string;
    /** The absolute home the session's transcript belongs to; the durable queue needs it. */
    sourceHome: string | null;
}

export interface SessionSendRequest extends SessionAddress {
    text: string;
    timing: SendTiming;
    /** Reused on a retry, so a retried send is the same delivery (the durable queue keys on it). */
    idempotencyKey?: string;
}

/** A send's receipt: the wire receipt without the board key a door adds. */
export type SessionSendReceipt = Omit<AgentSendReceiptDto, "key">;

/** What an interrupt (the Esc key of a TUI) did. `unknown` means the key may have been pressed. */
export type SessionInterruptReceipt = Omit<AgentInterruptReceiptDto, "key">;

/** What one timing does for a harness, for a caller that offers the choice (the phone shows a refused one greyed). */
export type TimingSupport = AgentSendTimingSupport;

/** One timing of one harness: how it sends, or why this harness cannot. */
export type TimingRoute =
    | { meaning: string; send(request: SessionSendRequest, edges: SendEdges): Promise<SessionSendReceipt> }
    | { refused: string };

/**
 * How one harness takes a message into a running session (M5). Every harness has one module in `senders/<id>.ts`
 * exporting `sessionSender`, so a new harness adds its module and edits no table here.
 */
export interface HarnessSender {
    timings: Record<SendTiming, TimingRoute>;
    /** Ends the running turn and keeps the session (the Esc key of its TUI), or why this harness cannot. */
    interrupt: { key: string } | { refused: string };
}

/** The transports a sender uses. Tests replace them, so no real session, pane or queue is touched. */
export interface SendEdges {
    /** The answer-route ladder (owned worker, the harness's structured route, the cmux pane, then the durable queue). */
    deliverNow(request: SessionSendRequest): Promise<SessionSendReceipt>;
    /** Codex's daemon queue (`codex queue --thread`): runs after the current turn. */
    codexQueue(request: SessionSendRequest): Promise<SessionSendReceipt>;
    /** The durable session queue alone, with no live attempt. */
    enqueue(request: SessionSendRequest): Promise<SessionSendReceipt>;
    /** One named key into the session's cmux pane, after the pane, tty and dialog guards. */
    pressKey(address: SessionAddress, key: string): Promise<SessionInterruptReceipt>;
}
