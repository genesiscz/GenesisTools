import { appendFeed, readFeed } from "./feed";
import type { AgentLeftEvent, FeedEvent, SessionPaths } from "./types";

/**
 * Names of the agents still on the bus: each one logged in at some point and has not left since.
 *
 * A `--once` receiver logs out after every message and logs in again, so `logged_out` is not leaving;
 * only `agent_left` is.
 */
export function remainingAgentNames(events: readonly FeedEvent[], leavingId: string): string[] {
    const present = presentAgents(events);
    present.delete(leavingId);
    return [...present.values()];
}

/** Agent id to name, for every agent that logged in and has not left since. */
export function presentAgents(events: readonly FeedEvent[]): Map<string, string> {
    const present = new Map<string, string>();

    for (const event of events) {
        if (event.type === "logged_in") {
            present.set(event.agent_id, event.agent_name);
        } else if (event.type === "agent_left") {
            present.delete(event.agent_id);
        }
    }

    return present;
}

/**
 * Log an agent in, and announce `agent_joined` when it was not on the bus. Called with the feed as it was
 * BEFORE this login, so a `--once` receiver's next cycle (already present) stays silent.
 */
export async function announceJoinIfNew(
    paths: SessionPaths,
    input: { agent_id: string; agent_name: string; before: readonly FeedEvent[] }
): Promise<boolean> {
    const present = presentAgents(input.before);

    if (present.has(input.agent_id)) {
        return false;
    }

    await appendFeed(paths, {
        type: "agent_joined",
        agent_id: input.agent_id,
        agent_name: input.agent_name,
        present: [...present.values()],
    });
    return true;
}

/** When a login ends, is that the agent leaving? One `--once` cycle (a message, a timeout) is not. */
export function loginEndIsLeave(
    mode: "stream" | "once",
    reason: "signal" | "clean_exit" | "cap"
): reason is "signal" | "cap" {
    return reason === "signal" || (mode === "stream" && reason === "cap");
}

export async function announceLeave(
    paths: SessionPaths,
    input: { agent_id: string; agent_name: string; reason: AgentLeftEvent["reason"]; note?: string }
): Promise<FeedEvent> {
    const remaining = remainingAgentNames(await readFeed(paths), input.agent_id);
    return appendFeed(paths, {
        type: "agent_left",
        agent_id: input.agent_id,
        agent_name: input.agent_name,
        reason: input.reason,
        remaining,
        ...(input.note ? { note: input.note } : {}),
    });
}
