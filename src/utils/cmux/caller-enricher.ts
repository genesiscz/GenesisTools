import type { CmuxTerminal, ContextEnricher } from "@genesiscz/utils/agent/identity/types";

/**
 * The cmux identity a process inherits, by variable name. A --via-tmux agent starts before its workspace exists, and
 * the tmux server may carry the CALLER's surface in its global environment; with it, the session hook would record
 * the agent in the caller's surface, and close or adoption could act on the caller's terminal. Without it, the hook
 * records the tmux pane, which is how close finds the agent's turn (session-close.ts `recordedSessionIdOf`).
 * `readCmuxTerminal` reads the same names.
 */
export const CMUX_IDENTITY_ENV = ["CMUX_SURFACE_ID", "CMUX_WORKSPACE_ID", "CMUX_PANEL_ID", "CMUX_TAB_ID"] as const;

/**
 * The cmux surface a caller's environment names, or undefined outside cmux. Pure and synchronous: no socket call, so
 * it answers even when the cmux socket is dead (the offline rescue path). A blank surface names none; the workspace
 * and the tab are kept only beside a surface, trimmed, and may be stale once the surface moves.
 */
export function readCmuxTerminal(env: NodeJS.ProcessEnv): CmuxTerminal | undefined {
    const surfaceId = env.CMUX_SURFACE_ID?.trim();

    if (!surfaceId) {
        return undefined;
    }

    return {
        surfaceId,
        workspaceId: env.CMUX_WORKSPACE_ID?.trim() || null,
        tabId: env.CMUX_TAB_ID?.trim() || null,
    };
}

export const cmuxCallerEnricher: ContextEnricher<"cmux"> = {
    id: "cmux",
    enrich: ({ env }) => readCmuxTerminal(env),
};
