import type { AgentSnapshot, AgentState } from "./types";

export const NOTABLE_STATES: ReadonlySet<AgentState> = new Set<AgentState>(["FINISHED", "STALLED", "AWAITING-INPUT"]);

/**
 * PURE transition gate. Notify only when entering a NOTABLE state from a
 * *different* state. First sighting (prev === undefined) notifies iff the
 * agent is already notable. Recovery into RUNNING and unchanged states are quiet.
 */
export function shouldNotify(prev: AgentState | undefined, next: AgentState): boolean {
    if (!NOTABLE_STATES.has(next)) {
        return false;
    }

    return prev !== next;
}

function describeState(snap: AgentSnapshot): string {
    switch (snap.state) {
        case "FINISHED": {
            const code = snap.exitCode ?? 0;
            return code === 0 ? "finished" : `finished with exit code ${code}`;
        }

        case "STALLED": {
            return "stalled (no output)";
        }

        case "AWAITING-INPUT": {
            return "is waiting for your input";
        }

        default: {
            return "is running";
        }
    }
}

export function transitionMessage(snap: AgentSnapshot): { title: string; message: string; subtitle?: string } {
    const title = `agent ${snap.name}`;
    const message = `${snap.name} ${describeState(snap)}`;
    const subtitle = snap.lastLine ? snap.lastLine.slice(0, 120) : undefined;
    return { title, message, subtitle };
}
