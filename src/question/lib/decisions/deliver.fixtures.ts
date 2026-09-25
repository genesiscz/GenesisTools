import type { SessionTargetsResult } from "@app/claude/lib/cmux/resolve";

/**
 * Delivery fakes for tests. `deliverToSession` resolves a live target BEFORE it types (R4), so a
 * test that fakes only `runTool` would queue: these say what the live cmux would say.
 */

/** One pane demonstrably running the session: a strong match, no snapshot to check it against. */
export function livePaneTargets(session: string): Promise<SessionTargetsResult> {
    return Promise.resolve({
        targets: [
            {
                workspaceId: "ws-1",
                workspaceName: "work",
                paneId: "pane:1",
                paneTitle: "agent",
                surfaceId: "surface:1",
                sessionIds: [session],
                matchedOn: "session-id",
                score: 90,
                active: true,
            },
        ],
        source: "titles",
        unavailable: false,
    });
}

/** No pane runs the session. */
export function noPaneTargets(): Promise<SessionTargetsResult> {
    return Promise.resolve({ targets: [], source: "none", unavailable: false });
}
