import type { CmuxTerminal, ContextEnricher } from "@genesiscz/utils/agent/identity/types";

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
