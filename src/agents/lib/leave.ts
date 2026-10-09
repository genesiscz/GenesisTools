import { logger } from "@genesiscz/utils/logger";
import { appendFeedEvents, appendFeedWhen, type NonMessageInput } from "./feed";
import type { AgentLeftEvent, AgentMode, FeedEvent, SessionPaths } from "./types";

const log = logger.child({ component: "agents:leave" });

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
    return new Map([...presence(events)].map(([id, entry]) => [id, entry.name]));
}

/**
 * Who is on the bus, with the login that put each agent there. A leave that names a login ends only that login:
 * a listener that stops after its replacement already logged in (the slot is released before the leave is
 * written) must not take the replacement off the bus. A leave without a login id (`tools agents leave`) ends
 * whichever login is current.
 */
function presence(events: readonly FeedEvent[]): Map<string, { name: string; loginId: string | undefined }> {
    const present = new Map<string, { name: string; loginId: string | undefined }>();

    for (const event of events) {
        if (event.type === "logged_in") {
            present.set(event.agent_id, { name: event.agent_name, loginId: event.login_id });
        } else if (event.type === "agent_left" && endsCurrentLogin(present.get(event.agent_id), event.login_id)) {
            present.delete(event.agent_id);
        }
    }

    return present;
}

function endsCurrentLogin(current: { loginId: string | undefined } | undefined, leaving: string | undefined): boolean {
    return !leaving || current?.loginId === undefined || current.loginId === leaving;
}

/**
 * Log an agent in, and announce `agent_joined` when it was not on the bus, in ONE feed reservation: presence is
 * read from the feed as it is right before `logged_in` is written. A presence snapshot taken earlier could miss an
 * old listener's leave that landed in between, and then the reopened channel would never be announced. A
 * `--once` receiver's next cycle (still present) stays silent.
 */
export async function logInAndAnnounceJoin(
    paths: SessionPaths,
    input: { agent_id: string; agent_name: string; mode: AgentMode; login_id: string }
): Promise<{ joined: boolean }> {
    const appended = await appendFeedEvents(paths, (events) => {
        const present = presentAgents(events);
        const loggedIn: NonMessageInput = {
            type: "logged_in",
            agent_id: input.agent_id,
            agent_name: input.agent_name,
            mode: input.mode,
            login_id: input.login_id,
        };

        if (present.has(input.agent_id)) {
            return [loggedIn];
        }

        return [
            loggedIn,
            {
                type: "agent_joined",
                agent_id: input.agent_id,
                agent_name: input.agent_name,
                present: [...present.values()],
            },
        ];
    });

    return { joined: appended.some((event) => event.type === "agent_joined") };
}

/**
 * When a login ends, is that the agent leaving, and why? One `--once` cycle that ends on mail is not; every end of a
 * stream login is, because nobody listens for that agent afterwards (`ended`: the watch stopped on its own, an error
 * for instance). A `--once` timeout or cap is announced by the login itself, where it knows which one it was.
 */
export function leaveReasonOf(
    mode: "stream" | "once",
    reason: "signal" | "clean_exit" | "cap"
): AgentLeftEvent["reason"] | null {
    if (reason === "signal") {
        return "signal";
    }

    if (mode === "stream") {
        return reason === "cap" ? "cap" : "ended";
    }

    return null;
}

/**
 * Announce that an agent left, or nothing (null) when `login_id` names a login that is no longer the agent's
 * current one: a newer login of the same agent took over, and it stays on the bus. Decided under the feed lock.
 */
export async function announceLeave(
    paths: SessionPaths,
    input: {
        agent_id: string;
        agent_name: string;
        reason: AgentLeftEvent["reason"];
        note?: string;
        login_id?: string;
    }
): Promise<FeedEvent | null> {
    const appended = await appendFeedWhen(paths, (events) => {
        if (!endsCurrentLogin(presence(events).get(input.agent_id), input.login_id)) {
            return null;
        }

        return {
            type: "agent_left",
            agent_id: input.agent_id,
            agent_name: input.agent_name,
            reason: input.reason,
            remaining: remainingAgentNames(events, input.agent_id),
            ...(input.note ? { note: input.note } : {}),
            ...(input.login_id ? { login_id: input.login_id } : {}),
        };
    });

    if (!appended) {
        log.debug({ agentId: input.agent_id, loginId: input.login_id }, "leave skipped: a newer login is current");
    }

    return appended;
}
