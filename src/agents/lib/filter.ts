import type { SessionMeta } from "./session-meta";
import type { AgentRecord, FeedEvent, MessageEvent } from "./types";

export function isVisibleToAgent(event: FeedEvent, agent: AgentRecord, meta?: SessionMeta): boolean {
    if (event.type === "message") {
        return visibleMessage(event, agent);
    }

    if (event.type === "logged_in" || event.type === "logged_out") {
        return visibleLifecycle(event, agent, meta);
    }

    if (event.type === "registered") {
        return Boolean(meta?.debug);
    }

    return false;
}

function visibleMessage(event: MessageEvent, agent: AgentRecord): boolean {
    if (event.from_agent_id === agent.agent_id) {
        return false;
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

    if (agent.is_main) {
        if (event.type === "logged_in") {
            return event.mode === "stream";
        }

        return event.reason !== "clean_exit";
    }

    return false;
}

export function filterForAgent(events: FeedEvent[], agent: AgentRecord, meta?: SessionMeta): FeedEvent[] {
    return events.filter((e) => isVisibleToAgent(e, agent, meta));
}
