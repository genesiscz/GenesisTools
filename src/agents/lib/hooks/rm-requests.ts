import type { RmRequest } from "@genesiscz/utils/rm/requests";
import { type HookPayload, toolOutputText } from "./payload";

/** A shell command that runs `tools rm` (or its entry file); any other command costs this hook nothing. */
const RM_COMMAND = /\btools\s+rm\b|[\\/]rm[\\/]index\.ts\b/;

/** A request this recent may be the one the call opened; an older one was seen by an earlier call. */
const RECENT_MS = 15 * 60_000;

export interface RmNoticeDeps {
    now: () => Date;
    /** The pending requests; `listRmRequests()` when absent. */
    requests?: () => readonly RmRequest[];
}

/**
 * The model-only line a PostToolUse hook adds after a `tools rm` call that opened a request its output did not show:
 * `tools rm x >/dev/null 2>&1` hid the request completely (session 259a9821 did it twice, and neither request was
 * passed on). It repeats the last line of the request hint, so the agent can tell the user.
 */
export async function rmRequestNotice(
    payload: HookPayload,
    deps: RmNoticeDeps = { now: () => new Date() }
): Promise<string | null> {
    if (!payload.sessionId || !RM_COMMAND.test(payload.command)) {
        return null;
    }

    // lazy: saves 28 ms cold import on every other Bash call (rm/requests, measured 2026-11-01); only tools rm calls read it
    const { listRmRequests, rmRequestHintLine } = await import("@genesiscz/utils/rm/requests");
    const output = toolOutputText(payload);
    const now = deps.now().getTime();
    const unseen = (deps.requests ?? (() => listRmRequests()))()
        .filter((request) => request.status === "pending" && request.caller?.sessionId === payload.sessionId)
        .filter((request) => now - Date.parse(request.createdAt) <= RECENT_MS)
        .filter((request) => !output.includes(request.id));

    if (unseen.length === 0) {
        return null;
    }

    return unseen.map((request) => rmRequestHintLine(request.id, request.targets.length)).join("\n");
}
