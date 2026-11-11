import type { SessionMeta } from "./session-meta";
import type { AgentJoinedEvent, AgentLeftEvent, AgentRecord, FeedEvent, MessageEvent, PresenceMode } from "./types";

export interface VisibilityOptions {
    /** The session's meta; its `debug` shows lifecycle events and every join and leave. */
    meta?: SessionMeta;
    /** The login's `--presence`; absent means the default for this agent (see `presenceModeFor`). */
    presence?: PresenceMode;
}

/**
 * The presence mode of a login. An explicit `--presence` wins. Otherwise a `--debug` session shows everyone every
 * join and leave, main gets the real changes (it steers the swarm and nudges a peer that lapsed), and every other
 * agent gets none: in the 2026-11-08 swarm 28% of the child turns woke only on a peer's join or leave.
 */
export function presenceModeFor({
    agent,
    meta,
    explicit,
}: {
    agent: AgentRecord;
    meta?: SessionMeta;
    explicit?: PresenceMode;
}): PresenceMode {
    if (explicit) {
        return explicit;
    }

    if (meta?.debug) {
        return "all";
    }

    return agent.is_main ? "changes" : "none";
}

/** Leave reasons an older writer posted for a login the agent restarts; `changes` hides them. */
const REARM_LEAVE_REASONS: ReadonlySet<AgentLeftEvent["reason"]> = new Set(["signal", "timeout"]);

function visiblePresence(event: AgentJoinedEvent | AgentLeftEvent, mode: PresenceMode): boolean {
    if (mode === "none") {
        return false;
    }

    if (mode === "all" || event.type === "agent_joined") {
        return true;
    }

    return !REARM_LEAVE_REASONS.has(event.reason);
}

export function isVisibleToAgent(event: FeedEvent, agent: AgentRecord, options: VisibilityOptions = {}): boolean {
    const { meta } = options;

    if (event.type === "message") {
        return visibleMessage(event, agent);
    }

    if (event.type === "logged_in" || event.type === "logged_out") {
        return visibleLifecycle(event, agent, meta);
    }

    if (event.type === "registered") {
        return Boolean(meta?.debug);
    }

    // Presence from before this agent registered is not news to it, and must not wake its first `--once`.
    if (event.type === "agent_left" || event.type === "agent_joined") {
        if (event.agent_id === agent.agent_id || event.seq <= agent.registered_seq) {
            return false;
        }

        return visiblePresence(event, presenceModeFor({ agent, meta, explicit: options.presence }));
    }

    return false;
}

function visibleMessage(event: MessageEvent, agent: AgentRecord): boolean {
    if (event.from_agent_id === agent.agent_id) {
        return false;
    }

    // Orchestrator follow: main's login stream is the swarm inbox, so a parent
    // monitor sees every hop, not only mail addressed to main.
    if (agent.is_main) {
        return true;
    }

    if (event.to_agent_ids.length === 0) {
        return true;
    }

    return event.to_agent_ids.includes(agent.agent_id);
}

function visibleLifecycle(event: FeedEvent, agent: AgentRecord, meta?: SessionMeta): boolean {
    if (event.type !== "logged_in" && event.type !== "logged_out") {
        return false;
    }

    if (event.agent_id === agent.agent_id) {
        return false;
    }

    if (event.mode === "once") {
        return false;
    }

    if (meta?.debug) {
        return true;
    }

    // Main learns arrivals from `agent_joined` and departures from `agent_left`. A login is not news: a Monitor
    // re-arm is one logged_out and one logged_in, and showing them woke the lead twice per peer every 30 minutes.
    // A logout that is no re-arm and no clean exit (a stream login that hit its cap, an old dead lock) still shows.
    if (agent.is_main) {
        return event.type === "logged_out" && event.reason !== "clean_exit" && !event.rearm_until;
    }

    return false;
}

export function filterForAgent(events: FeedEvent[], agent: AgentRecord, options: VisibilityOptions = {}): FeedEvent[] {
    return events.filter((e) => isVisibleToAgent(e, agent, options));
}
