import { runCmuxJSON } from "@genesiscz/utils/cmux/lib/cli";
import { env } from "@genesiscz/utils/env";

/** What `cmux identify` says about the process asking, plus what its own environment claims. */
export interface SelfSendFacts {
    tmuxPane?: string;
    envSurfaceId?: string;
    callerSurfaceId?: string;
    callerSurfaceType?: string;
}

export type SelfSendVerdict = { ok: true; detail: string } | { ok: false; detail: string; fix: string };

/**
 * Would `tools cmux send-self` reach this process's own prompt?
 *
 * Read-only by construction: it compares what the environment claims against
 * what the app resolves, and never sends anything. `doctor` was green while
 * send-self failed, because health only probes the socket and the UI thread —
 * neither notices that the surface being addressed is the wrong one.
 */
export function classifySelfSend(facts: SelfSendFacts): SelfSendVerdict {
    if (facts.tmuxPane) {
        return { ok: true, detail: `ok (tmux pane ${facts.tmuxPane})` };
    }

    if (!facts.envSurfaceId && !facts.callerSurfaceId) {
        return {
            ok: false,
            detail: "unavailable (not inside tmux or cmux)",
            fix: "there is no keystroke transport here — schedule with CronCreate instead",
        };
    }

    if (facts.callerSurfaceType && facts.callerSurfaceType !== "terminal") {
        return {
            ok: false,
            detail: `FAILS (this surface is a ${facts.callerSurfaceType}, not a terminal)`,
            fix: "a non-terminal surface cannot accept keystrokes — schedule with CronCreate instead",
        };
    }

    if (facts.envSurfaceId && facts.callerSurfaceId && facts.envSurfaceId !== facts.callerSurfaceId) {
        return {
            ok: false,
            detail: `FAILS (CMUX_SURFACE_ID names ${facts.envSurfaceId}, cmux resolves ${facts.callerSurfaceId})`,
            fix: "the environment is stale — the text would land in another surface; restart the shell",
        };
    }

    return { ok: true, detail: `ok (cmux surface ${facts.callerSurfaceId ?? facts.envSurfaceId})` };
}

interface IdentifyCaller {
    caller?: { surface_id?: string; surface_type?: string };
}

/** Gather the facts. Never throws: an unreachable app is reported, not raised. */
export async function probeSelfSend(): Promise<SelfSendVerdict> {
    const environment = env.getProcessEnv();
    const facts: SelfSendFacts = {
        tmuxPane: environment.TMUX_PANE,
        envSurfaceId: environment.CMUX_SURFACE_ID,
    };

    if (facts.tmuxPane) {
        return classifySelfSend(facts);
    }

    try {
        const identify = await runCmuxJSON<IdentifyCaller>(["identify"], { timeoutMs: 5000 });
        facts.callerSurfaceId = identify.caller?.surface_id;
        facts.callerSurfaceType = identify.caller?.surface_type;
    } catch {
        return { ok: false, detail: "unknown (identify did not answer)", fix: "see the ping/identify lines above" };
    }

    return classifySelfSend(facts);
}
