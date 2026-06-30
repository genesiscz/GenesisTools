export type AgentMode = "stream" | "once";

export type LifecycleEventType = "registered" | "logged_in" | "logged_out" | "stale_lock_reaped";

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
}

export interface LoggedOutEvent extends FeedEventBase {
    type: "logged_out";
    agent_id: string;
    reason: "signal" | "clean_exit" | "dead_pid" | "cap";
    mode?: AgentMode;
}

export interface StaleLockReapedEvent extends FeedEventBase {
    type: "stale_lock_reaped";
    lock: string;
    pid?: number;
    reason: "dead_pid" | "unreadable";
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

export type FeedEvent = RegisteredEvent | LoggedInEvent | LoggedOutEvent | StaleLockReapedEvent | MessageEvent;

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
    since: string;
    owner: string;
    kind: "login";
    mode?: AgentMode;
}

export interface SessionPaths {
    session: string;
    sessionDir: string;
    feedPath: string;
    slotsDir: string;
}
