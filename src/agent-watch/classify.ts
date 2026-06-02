import type { AgentEvent, AgentState, ClassifyInput } from "./types";

function latestEvent(events: AgentEvent[]): AgentEvent | undefined {
    if (events.length === 0) {
        return undefined;
    }

    return events[events.length - 1];
}

/**
 * PURE state classifier. Reads no clock and no filesystem — `now`, `lastModified`,
 * and `pidAlive` are injected. Decision order matters:
 *   1. exit event present  → FINISHED   (terminal; outranks everything)
 *   2. latest is question  → AWAITING-INPUT (a prompt is not a stall)
 *   3. pid confirmed dead  → FINISHED   (process gone without an exit line)
 *   4. stale past timeout  → STALLED
 *   5. otherwise           → RUNNING
 */
export function classifyAgentState(input: ClassifyInput): AgentState {
    const { events, lastModified, now, stallTimeoutMs, pidAlive } = input;
    const last = latestEvent(events);

    if (events.some((e) => e.kind === "exit")) {
        return "FINISHED";
    }

    if (last?.kind === "question") {
        return "AWAITING-INPUT";
    }

    if (pidAlive === false) {
        return "FINISHED";
    }

    const lastActivity = last ? Math.max(last.ts, lastModified) : lastModified;
    if (now - lastActivity > stallTimeoutMs) {
        return "STALLED";
    }

    return "RUNNING";
}
