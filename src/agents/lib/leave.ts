import { logger } from "@genesiscz/utils/logger";
import { appendFeedEvents, appendFeedWhen, type NonMessageInput } from "./feed";
import type { AgentLeftEvent, AgentMode, FeedEvent, SessionPaths } from "./types";

const log = logger.child({ component: "agents:leave" });

/**
 * How long a login that ended by a signal, a `--once --timeout` or a dead pid keeps its agent on the bus, waiting
 * for the agent's next login. Measured in the 2026-11-08 swarm: Monitor re-arms came back after 3 to 34 s, one
 * after 79 s. A re-arm inside it writes no presence event; a lapse after it writes one `agent_left` (`lapsed`).
 */
export const REARM_GRACE_MS = 90_000;

export function rearmUntil(now: number = Date.now()): string {
    return new Date(now + REARM_GRACE_MS).toISOString();
}

/** Does a login that ended this way get a re-arm grace instead of a leave? A harness kills a Monitor's login. */
export function endsInRearm(reason: "signal" | "clean_exit" | "cap"): boolean {
    return reason === "signal";
}

/** A login that ended in a way its agent restarts, and has not been replaced yet. */
export interface PendingRearm {
    loginId: string;
    /** When the login ended (the `logged_out` ts). */
    since: string;
    /** Its `rearm_until`. */
    until: string;
}

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
 * When a login ends, is that the agent leaving, and why? One `--once` cycle that ends on mail is not, and neither is
 * a killed login or a `--once --timeout` (both re-arm, see `REARM_GRACE_MS`). Every other end of a stream login is,
 * because nobody listens for that agent afterwards (`ended`: the watch stopped on its own, an error for instance).
 * A `--once` receiver that waited the whole cap is announced by the login itself (`cap`).
 */
export function leaveReasonOf(
    mode: "stream" | "once",
    reason: "signal" | "clean_exit" | "cap"
): AgentLeftEvent["reason"] | null {
    // A killed login (a harness Monitor expiring after 30 minutes) is a re-arm, not a leave: its `logged_out`
    // carries `rearm_until`, and `announceLapses` writes the leave only when no new login follows.
    if (endsInRearm(reason)) {
        return null;
    }

    if (mode === "stream") {
        return reason === "cap" ? "cap" : "ended";
    }

    return null;
}

/**
 * Announce that an agent left, or nothing (null) when it is not on the bus, or when `login_id` names a login that is
 * no longer the agent's current one (a newer login of the same agent took over and stays). Decided under the feed lock.
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
        const current = presence(events).get(input.agent_id);

        // Not on the bus (it left already, or never logged in): another agent_left would wake every peer for a
        // departure that did not happen.
        if (!current || !endsCurrentLogin(current, input.login_id)) {
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
        log.debug(
            { agentId: input.agent_id, loginId: input.login_id },
            "leave skipped: the agent is not on the bus, or a newer login is current"
        );
    }

    return appended;
}

/**
 * The pending re-arms folded from a feed: agent id to the login that ended and may come back, and agent id to the
 * login it is on now. A login releases its slot before it writes its `logged_out`, so the logout of an older login
 * can land after its replacement logged in and out; it must not take the replacement's place.
 */
export interface RearmFold {
    pending: Map<string, PendingRearm>;
    /** The `login_id` of each agent's latest `logged_in` (undefined for a login written without one). */
    logins: Map<string, string | undefined>;
}

/**
 * Fold one feed event into the pending re-arms. Every watching login keeps this fold from the events it reads, so it
 * can tell when a lapse is due without reading the whole feed; `foldRearms` is the same fold over a whole feed. A
 * logout or a leave that names an older login than the agent's current one changes nothing, as in `presence`.
 */
export function trackRearm(fold: RearmFold, event: FeedEvent): void {
    if (event.type === "logged_in") {
        fold.logins.set(event.agent_id, event.login_id);
        fold.pending.delete(event.agent_id);
        return;
    }

    if (event.type !== "logged_out" && event.type !== "agent_left") {
        return;
    }

    const current = fold.logins.has(event.agent_id) ? { loginId: fold.logins.get(event.agent_id) } : undefined;

    if (!endsCurrentLogin(current, event.login_id)) {
        return;
    }

    if (event.type === "agent_left") {
        fold.logins.delete(event.agent_id);
        fold.pending.delete(event.agent_id);
    } else if (event.rearm_until && event.login_id) {
        fold.pending.set(event.agent_id, { loginId: event.login_id, since: event.ts, until: event.rearm_until });
    }
}

export function foldRearms(events: readonly FeedEvent[]): RearmFold {
    const fold: RearmFold = { pending: new Map(), logins: new Map() };

    for (const event of events) {
        trackRearm(fold, event);
    }

    return fold;
}

/** The agents on the bus whose current login ended with a `rearm_until` and was not replaced. */
export function pendingRearms(events: readonly FeedEvent[]): Map<string, PendingRearm & { agentName: string }> {
    const { pending } = foldRearms(events);
    const present = presence(events);
    const result = new Map<string, PendingRearm & { agentName: string }>();

    for (const [agentId, entry] of pending) {
        const current = present.get(agentId);

        if (current && endsCurrentLogin(current, entry.loginId)) {
            result.set(agentId, { ...entry, agentName: current.name });
        }
    }

    return result;
}

/** Is a re-arm in `pending` past its `rearm_until`? A cheap check before `announceLapses` takes the feed lock. */
export function hasDueRearm(pending: ReadonlyMap<string, PendingRearm>, now: number = Date.now()): boolean {
    for (const entry of pending.values()) {
        if (Date.parse(entry.until) <= now) {
            return true;
        }
    }

    return false;
}

/**
 * Write one `agent_left` with `reason: "lapsed"` for every agent whose re-arm is past its `rearm_until`. Decided
 * under the feed lock, so several watching logins (and `runStaleSweep`) never write the same lapse twice, and a new
 * login that landed first cancels it.
 */
export async function announceLapses(paths: SessionPaths, now: number = Date.now()): Promise<FeedEvent[]> {
    const appended = await appendFeedEvents(paths, (events) => {
        const due = [...pendingRearms(events)].filter(([, entry]) => Date.parse(entry.until) <= now);

        if (due.length === 0) {
            return [];
        }

        const lapsing = new Set(due.map(([agentId]) => agentId));
        const remaining = [...presentAgents(events)]
            .filter(([agentId]) => !lapsing.has(agentId))
            .map(([, name]) => name);

        return due.map(
            ([agentId, entry]): NonMessageInput => ({
                type: "agent_left",
                agent_id: agentId,
                agent_name: entry.agentName,
                reason: "lapsed",
                remaining,
                login_id: entry.loginId,
                lapsed_since: entry.since,
            })
        );
    });

    if (appended.length > 0) {
        log.debug({ agents: appended.map((event) => event.type === "agent_left" && event.agent_name) }, "lapsed");
    }

    return appended;
}

/**
 * `announceLapses` for the re-arms a watching login folded, then forget exactly the entries that were due. One cutoff
 * serves both: a re-arm that falls due while the feed lock is awaited was not announced, so it stays for the next
 * check (with a fresh time it was dropped, and the agent stayed on the bus for good). An entry a newer event replaced
 * meanwhile is not the one that was due, and stays too. A due lapse another login wrote first is in the feed already.
 */
export async function announceDueLapses(
    paths: SessionPaths,
    fold: RearmFold,
    now: number = Date.now()
): Promise<FeedEvent[]> {
    const due = [...fold.pending].filter(([, entry]) => Date.parse(entry.until) <= now);
    const appended = await announceLapses(paths, now);

    for (const [agentId, entry] of due) {
        if (fold.pending.get(agentId) === entry) {
            fold.pending.delete(agentId);
        }
    }

    return appended;
}

/** Why a recipient will not read a message now; `message` reports it to the sender. */
export interface NotListening {
    agent_id: string;
    /** `rearming`: its login ended and the grace for the next one runs. `left`: it left the bus. */
    state: "rearming" | "left" | "never_logged_in";
    /** When the login ended or the leave was written. */
    since?: string;
    /** With `left`: the leave's reason. */
    reason?: AgentLeftEvent["reason"];
}

/**
 * The recipients among `agentIds` that are not listening right now. A `--once` receiver between two cycles counts
 * as listening: it is on the bus and reads its mail at its next login.
 */
export function notListening(events: readonly FeedEvent[], agentIds: readonly string[]): NotListening[] {
    const present = presence(events);
    const rearming = pendingRearms(events);
    const result: NotListening[] = [];

    for (const agentId of agentIds) {
        const pending = rearming.get(agentId);

        if (pending) {
            result.push({ agent_id: agentId, state: "rearming", since: pending.since });
            continue;
        }

        if (present.has(agentId)) {
            continue;
        }

        const lastLeave = events.findLast(
            (event): event is AgentLeftEvent => event.type === "agent_left" && event.agent_id === agentId
        );
        result.push(
            lastLeave
                ? { agent_id: agentId, state: "left", since: lastLeave.ts, reason: lastLeave.reason }
                : { agent_id: agentId, state: "never_logged_in" }
        );
    }

    return result;
}
