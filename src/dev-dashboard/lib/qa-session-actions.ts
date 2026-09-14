import { resumeCommandFor } from "@app/dev-dashboard/lib/session-focus";

export type SessionActionName = "focus" | "cmux" | "copyId" | "copyResume";

export interface SessionActionState {
    enabled: boolean;
    /** One line, shown on the card when the action is unavailable. Empty when enabled. */
    reason: string;
}

export interface SessionActionInputs {
    sessionId: string | null | undefined;
    /** From /api/cmux/snapshot. `false` while it is still loading — actions stay usable. */
    cmuxUnavailable?: boolean;
    cmuxPaneCount?: number;
}

const NO_SESSION = "This entry carries no session id, so there is nothing to jump to.";
const NO_CMUX = "cmux is not reachable right now.";
const NO_PANES = "cmux has no open pane.";

export function hasRealSessionId(sessionId: string | null | undefined): boolean {
    const id = sessionId?.trim() ?? "";

    return id.length > 0 && id !== "unknown";
}

/**
 * Which of the four session verbs are usable for one card, and the one-line reason when not.
 *
 * Copying never needs cmux, so a dead cmux only disables Focus and the picker — the card
 * stays useful instead of going fully inert.
 */
export function sessionActionStates(inputs: SessionActionInputs): Record<SessionActionName, SessionActionState> {
    const ok: SessionActionState = { enabled: true, reason: "" };

    if (!hasRealSessionId(inputs.sessionId)) {
        const blocked: SessionActionState = { enabled: false, reason: NO_SESSION };

        return { focus: blocked, cmux: blocked, copyId: blocked, copyResume: blocked };
    }

    let cmuxState: SessionActionState = ok;

    if (inputs.cmuxUnavailable) {
        cmuxState = { enabled: false, reason: NO_CMUX };
    } else if (inputs.cmuxPaneCount === 0) {
        cmuxState = { enabled: false, reason: NO_PANES };
    }

    return { focus: cmuxState, cmux: cmuxState, copyId: ok, copyResume: ok };
}

/** The single line rendered under the action row, or null when every verb is usable. */
export function sessionActionsNotice(states: Record<SessionActionName, SessionActionState>): string | null {
    const blocked = Object.values(states).find((state) => !state.enabled);

    return blocked ? blocked.reason : null;
}

export { resumeCommandFor };
