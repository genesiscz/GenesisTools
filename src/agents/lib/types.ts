export type AgentMode = "stream" | "once";

export type LifecycleEventType =
    | "registered"
    | "logged_in"
    | "logged_out"
    | "stale_lock_reaped"
    | "agent_joined"
    | "agent_left";

export type CommEventType = "message";

export type FeedEventType = LifecycleEventType | CommEventType;

export interface FeedEventBase {
    seq: number;
    ts: string;
    type: FeedEventType;
}

export interface RegisteredEvent extends FeedEventBase {
    type: "registered";
    agent_name: string;
    agent_id: string | null;
    awaiting_login: boolean;
    is_main: boolean;
    role: string | null;
    meta: Record<string, unknown>;
}

export interface LoggedInEvent extends FeedEventBase {
    type: "logged_in";
    agent_id: string;
    agent_name: string;
    mode: AgentMode;
    /** One id per login process. A leave that names an older login of the same agent does not end this one. */
    login_id?: string;
}

export interface LoggedOutEvent extends FeedEventBase {
    type: "logged_out";
    agent_id: string;
    reason: "signal" | "clean_exit" | "dead_pid" | "cap";
    mode?: AgentMode;
}

/**
 * An agent came onto the bus: its first login, or its first after an `agent_left`. A `--once` receiver logs in
 * again after every message, and those logins are not joins. Every other agent sees it, so the agent that asked
 * for the channel learns the moment its peer is listening.
 */
export interface AgentJoinedEvent extends FeedEventBase {
    type: "agent_joined";
    agent_id: string;
    agent_name: string;
    /** Names of the other agents already on the bus. */
    present: string[];
}

/**
 * An agent stopped listening for good, as opposed to one `--once` cycle ending. Every other agent sees it,
 * so a `--once` receiver wakes on it, and `remaining` names who is still on the bus.
 */
export interface AgentLeftEvent extends FeedEventBase {
    type: "agent_left";
    agent_id: string;
    agent_name: string;
    /**
     * `leave`: `tools agents leave`. `signal`/`cap`: its login ended that way. `timeout`: a `--once --timeout`
     * receiver expired with no mail (a restart is a new join). `dead_pid`: its login was reaped. `ended`: a stream
     * login stopped on its own (its watch failed). A `--once` receiver that waited the whole cap leaves with `cap`.
     */
    reason: "leave" | "signal" | "cap" | "timeout" | "dead_pid" | "ended";
    /** Names of the agents still on the bus, the leaver excluded. */
    remaining: string[];
    note?: string;
    /** The login that ended; absent for `tools agents leave`, which ends whichever login is current. */
    login_id?: string;
}

export interface StaleLockReapedEvent extends FeedEventBase {
    type: "stale_lock_reaped";
    lock: string;
    pid?: number;
    reason: "dead_pid" | "recycled_pid" | "unreadable";
}

export interface MessageEvent extends FeedEventBase {
    type: "message";
    message_id: string;
    from_agent_id: string;
    from_agent_name: string;
    to_agent_ids: string[];
    body: string;
    meta: Record<string, unknown>;
    private: boolean;
    in_reply_to?: string;
}

export type FeedEvent =
    | RegisteredEvent
    | LoggedInEvent
    | LoggedOutEvent
    | StaleLockReapedEvent
    | AgentJoinedEvent
    | AgentLeftEvent
    | MessageEvent;

/**
 * Derived from feed events via deriveRegistry(). Not persisted.
 * Delivery cursor (last_delivered_seq) lives in a per-agent .cursor sidecar.
 */
export interface AgentRecord {
    agent_id: string;
    agent_name: string;
    is_main: boolean;
    role: string | null;
    registered_at: string;
    logged_in_at: string | null;
    logged_out_at: string | null;
    mode: AgentMode | null;
    meta: Record<string, unknown>;
}

export interface SlotLockPayload {
    pid: number;
    /** Command line of `pid` at lock time — lets the sweep detect pid reuse. */
    command?: string;
    since: string;
    owner: string;
    kind: "login";
    mode?: AgentMode;
    /** The `login_id` of the holding login, so a reaped login's leave names that login only. */
    login_id?: string;
}

export interface SessionPaths {
    session: string;
    sessionDir: string;
    feedPath: string;
    slotsDir: string;
}
