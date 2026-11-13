// When each agent loop of this session last did something: sent a model request, started or finished a tool call,
// ended a turn. The agents band shows the time since as `idle`, and the resume guard reads it as the age of the
// agent's prompt cache. One clock for both, fed by the engine events `register.tsx` hands every feature, so it also
// runs in a session nobody watches, where the band does not.
import type { Feature } from "./shared";

const lastActive = new Map<string, number>();

/** The clock the agent clock and the resume guard read; a test moves it. */
export const agentClockTime = { now: (): number => Date.now() };

/** The agent `agentId` did something at `at`; an earlier time than the one held changes nothing. */
export function noteAgentActive(agentId: string, at = agentClockTime.now()): void {
    if ((lastActive.get(agentId) ?? 0) < at) {
        lastActive.set(agentId, at);
    }
}

/** When the agent last did something since this module loaded; undefined when it did nothing since (a reload). */
export function agentActiveAt(agentId: string): number | undefined {
    return lastActive.get(agentId);
}

/** A test starts a different session. */
export function forgetAgentClock(): void {
    lastActive.clear();
}

/** Feeds the clock from every subagent's and teammate's loop; the main loop has no agent id and is not timed here. */
export const agentClock: Feature = {
    beforeTool(_host, e) {
        if (e.agentId !== undefined) {
            noteAgentActive(e.agentId);
        }

        return undefined;
    },
    async afterTool(_host, e) {
        if (e.agentId !== undefined) {
            noteAgentActive(e.agentId);
        }
    },
    async beforeStep(_host, e) {
        if (e.agentId !== undefined) {
            noteAgentActive(e.agentId);
        }
    },
    afterStep(_host, e) {
        noteAgentActive(e.agentId);
    },
    async afterTurn(_host, e) {
        if (e.agentId !== undefined) {
            noteAgentActive(e.agentId);
        }
    },
};
