// The `/api/live` wire: one SSE stream per client that carries every live channel. Types only, so the phone
// bundle pulls in nothing at runtime (contract-purity.test.ts).
//
// A channel is one key of `LiveChannelFrames`; its value maps each frame type to its payload. Adding a channel is
// one key here, then one row in each table the compiler names: the server's `LIVE_PRODUCERS`
// (`lib/live/producers.ts`) and the phone's `LIVE_CACHE_TABLE` and `LIVE_POLL_FALLBACK`
// (`DevDashboard/mobile/src/live/`).

import type { AgentBoardPhaseRow } from "@app/dev-dashboard/contract/agents";
import type { AiUsageResult } from "@app/dev-dashboard/contract/ai-accounts";
import type { EnrichedQaEntry, PortInfo, PortsResult, PulseSnapshot } from "@app/dev-dashboard/contract/dto";
import type { AskForm, PendingEventKind } from "@app/question/lib/pending/types";

/** One line of the decision event log (`~/.genesis-tools/question/decisions/events.jsonl`), as the stream forwards it. */
export interface LiveDecisionEvent {
    ev: string;
    /** The decision the event names. A batch event (`prompt_sent`) names several in `ids` instead. */
    id?: string;
    ids?: string[];
    ts: string;
    /**
     * The state an `updated` event moved the decision to (`answered`, `acknowledged`, `dismissed`, …). With `ev`, a
     * client tells a posted decision (`created`) from an answered one (`updated` with `state: "answered"`).
     */
    state?: string;
}

/** A pending ask form changed: created, answered, cancelled or timed out. */
export interface LivePendingEvent {
    id: string;
    ev: PendingEventKind;
    ts: number;
    form: AskForm;
}

/** A handoff changed. The stream names it; a reader fetches the handoff itself. */
export interface LiveHandoffEvent {
    id: string;
    ev: string;
    ts: string;
}

/**
 * Every channel and its frames. A `snapshot` frame carries the whole current value; the other types carry a change.
 * Channels without a snapshot (qa, decisions, handoffs) are notices: a client refetches what they name, and refetches
 * everything they cover when a connection opens, since it may have missed notices while it was away.
 */
export interface LiveChannelFrames {
    ports: { snapshot: PortsResult; classify: { ports: PortInfo[] } };
    pulse: { snapshot: PulseSnapshot };
    /** The all-provider usage cache changed on disk. `native` is already stripped. */
    "ai-usage": { snapshot: AiUsageResult };
    qa: { entry: EnrichedQaEntry };
    decisions: { event: LiveDecisionEvent };
    pending: { snapshot: { forms: AskForm[] }; event: LivePendingEvent };
    handoffs: { event: LiveHandoffEvent };
    /**
     * The live agent sessions (F3, from the fleet view). `snapshot` is the whole set, sent on join and whenever a
     * session starts or ends; `phase` is one session whose phase, stalled flag or stuck verdict changed.
     */
    agents: { snapshot: { sessions: AgentBoardPhaseRow[] }; phase: AgentBoardPhaseRow };
}

export type LiveChannel = keyof LiveChannelFrames;

/** The frames of one channel, discriminated by `type`. Distributes over a union of channels. */
export type LiveFrameOf<C extends LiveChannel> = C extends LiveChannel
    ? {
          [T in keyof LiveChannelFrames[C] & string]: { v: 1; channel: C; type: T; payload: LiveChannelFrames[C][T] };
      }[keyof LiveChannelFrames[C] & string]
    : never;

/** A frame of any data channel. */
export type LiveDataFrame = LiveFrameOf<LiveChannel>;

/** The stream's own frames: the connection id on open, the channel set after a change, a server error. */
export type LiveSystemFrame =
    | { v: 1; channel: "system"; type: "hello"; payload: { connId: string; channels: LiveChannel[] } }
    | { v: 1; channel: "system"; type: "subscribed"; payload: { channels: LiveChannel[] } }
    | { v: 1; channel: "system"; type: "error"; payload: { message: string } };

export type LiveFrame = LiveSystemFrame | LiveDataFrame;

/** `POST /api/live/subscribe`: replace one connection's channel set. */
export interface LiveSubscribeBody {
    connId: string;
    /** Full replacement set. */
    channels: LiveChannel[];
}
