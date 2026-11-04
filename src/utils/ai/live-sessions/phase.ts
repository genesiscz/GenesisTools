import type { LivePhase } from "@genesiscz/utils/ai/transcripts/turn-state";

/**
 * What a live session is doing, the one value every fleet reader shows (the cmux inventory, the dev-dashboard agent
 * phase channel, the phone's agents board). It is `liveActivityOf`'s phase (`transcripts/turn-state.ts`), so a session
 * that waits on a question reads `waiting` everywhere, never `idle`. `stalled` rides beside it as a flag: a running
 * turn (`thinking` or `tool`) that went silent or loops is still that phase, and the flag says it may need rescue.
 *
 * The stall clocks keep their own purposes and are not merged here:
 * - 90 s (`src/utils/agents/dialogs/`): a native dialog that stopped answering is given up on.
 * - 10 min (`LIVE_STALL_MS`, `transcripts/turn-state.ts`): the `stalled` flag of this view.
 * - 15 min (the cmux close guard, and a sub-agent's `stopped` state): close refuses a session that ran this recently.
 *
 * The hub's `AgentStatus` and the widget's status keep their own maps; this table is for fleet readers.
 */
export type FleetPhase = LivePhase;

/** The words a fleet reader prints: a phase, `stalled` for a stalled running turn, `unknown` for an unread session. */
export type FleetPhaseLabel = FleetPhase | "stalled" | "unknown";

export interface FleetPhaseInfo {
    /** The short word a table cell shows. */
    label: FleetPhase;
    /** One sentence for a tooltip or a badge's accessible name. */
    detail: string;
    /** Whether the user is the one who must act next. */
    needsUser: boolean;
    /** Whether the agent's turn is still running, so a silence can mean `stalled`. */
    running: boolean;
}

/** Every phase to what a fleet reader shows for it. A new phase fails the build until it has a row here. */
export const FLEET_PHASES = {
    thinking: { label: "thinking", detail: "The model is working on its turn.", needsUser: false, running: true },
    tool: { label: "tool", detail: "A tool call is running.", needsUser: false, running: true },
    waiting: {
        label: "waiting",
        detail: "The agent asks a question or waits for an approval.",
        needsUser: true,
        running: false,
    },
    idle: {
        label: "idle",
        detail: "The turn is finished; the agent waits for a prompt.",
        needsUser: false,
        running: false,
    },
    interrupted: { label: "interrupted", detail: "The turn was interrupted.", needsUser: true, running: false },
} as const satisfies Record<FleetPhase, FleetPhaseInfo>;

/** The label for a phase and its stall flag: `stalled` only for a running turn, `unknown` when no phase was read. */
export function fleetPhaseLabel(input: { phase: FleetPhase | null; stalled: boolean }): FleetPhaseLabel {
    if (input.phase === null) {
        return "unknown";
    }

    const info = FLEET_PHASES[input.phase];
    return input.stalled && info.running ? "stalled" : info.label;
}
