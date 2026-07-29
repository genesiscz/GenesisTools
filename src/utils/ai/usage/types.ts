/**
 * One usage record, written by whoever spent the tokens.
 *
 * Every AI surface used to answer "what did this cost" from its own store: the
 * ai-proxy client ledger, claude's usage history DB, ask's per-call log line.
 * None of them could answer it across surfaces, because none of them saw the
 * others' rows. This is the shape they all agree on.
 *
 * The type is FROZEN for the phase that introduced it (Phase 8c). An emitter
 * that needs to carry something else puts it in `meta` — widening the record
 * mid-phase would silently invalidate every day-file already on disk, which is
 * append-only JSONL and never rewritten.
 */
export interface UsageEvent {
    /**
     * ISO-8601 instant the call finished. Also decides which day-file the row
     * lands in (UTC day), so it is the one field that must never be a local-time
     * string.
     */
    at: string;
    /**
     * Which surface spent it: `ask`, `ai-proxy`, `claude`, `youtube`, `say`,
     * `transcribe`, … Free-form on purpose — a new tool should be able to emit
     * before anything central knows it exists.
     */
    app: string;
    /**
     * `AccountEntry.id` (`acc_…`) that pays. Emitters that only know a human
     * account name may write the name; readers treat this as an opaque key and
     * group by it, so a mixed corpus degrades to two groups rather than a crash.
     */
    accountId: string;
    /** Provider/plugin id the call went to: `anthropic`, `anthropic-sub`, `xai`, … */
    provider: string;
    /** Concrete model id as billed, not an alias. */
    modelId: string;
    inputTokens: number;
    outputTokens: number;
    /**
     * USD for this event. ABSENT means no rate was known — never "free", and
     * never zero: `queryUsage` counts those separately as `unpricedEvents` so a
     * total can say how much of itself is missing.
     */
    costUsd?: number;
    /**
     * Emitter-specific detail. Known keys, by emitter:
     *  - claude usage poller: `{ kind: "bucket-snapshot", bucket, utilization, resetsAt }`
     *  - ai-proxy ledger: `{ kind: "proxy-request", client }`
     */
    meta?: Record<string, unknown>;
}

/**
 * What an emitter passes to `recordUsage`.
 *
 * `at` defaults to now and `costUsd` is derived from the catalog when omitted,
 * which is the whole reason this is not just `UsageEvent`. A `costUsd` that IS
 * supplied is stored verbatim and never recomputed — that is what keeps the
 * ai-proxy ledger's booked-at-write-time invoicing rates authoritative for its
 * own rows.
 */
export interface UsageEventInput extends Omit<UsageEvent, "at" | "costUsd"> {
    at?: string | Date;
    costUsd?: number;
}

/**
 * A half-open window plus optional filters. `from` is inclusive, `to` is
 * exclusive, both accepting either a full ISO instant or a bare `YYYY-MM-DD`.
 *
 * Both bounds are required: an unbounded query would read every day-file ever
 * written, and the caller who wants that can say so in one line.
 */
export interface UsageQuery {
    from: string;
    to: string;
    app?: string | string[];
    accountId?: string | string[];
}

/** Folded totals for a set of events. */
export interface UsageAggregate {
    events: number;
    inputTokens: number;
    outputTokens: number;
    /** Sum of the events that HAD a cost. See `unpricedEvents` for the rest. */
    costUsd: number;
    /** Events with no `costUsd` — the part of the total that is unknown, not zero. */
    unpricedEvents: number;
}

export interface UsageQueryResult {
    total: UsageAggregate;
    byApp: Record<string, UsageAggregate>;
    byAccount: Record<string, UsageAggregate>;
    byModel: Record<string, UsageAggregate>;
    /** The matching rows, oldest first. */
    events: UsageEvent[];
}
