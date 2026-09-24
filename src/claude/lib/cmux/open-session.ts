import { buildLaunchCommand, paneTitle } from "@app/claude/lib/cmux/command";
import { findCandidate } from "@app/claude/lib/cmux/sessions";
import type { PlannedSession } from "@app/claude/lib/cmux/types";
import { type OpenSessionTarget, openCommandAt } from "@genesiscz/utils/cmux/open-command";
import { profiler } from "@genesiscz/utils/profile";

export interface OpenSessionResult {
    sessionId: string;
    command: string;
    workspaceRef: string;
    surfaceRef: string;
    target: OpenSessionTarget["kind"];
}

/**
 * Resume a session at a chosen level of the cmux hierarchy (see `OpenSessionTarget`). The launch
 * command comes from the same builder restore uses, so the session resumes under the account and
 * auth mode it was pinned to.
 */
export async function openSessionAt(
    sessionId: string,
    target: OpenSessionTarget,
    opts: { enter?: boolean } = {}
): Promise<OpenSessionResult> {
    const prof = profiler.scope("claude-cmux-open");
    const candidate = await prof.measureAsync("candidate", () => findCandidate(sessionId));

    if (!candidate) {
        throw new Error(`No local session matches "${sessionId}" (need a full id or an 8+ char prefix)`);
    }

    const planned: PlannedSession = { candidate, account: candidate.account, model: candidate.model };
    const command = buildLaunchCommand(planned);
    const placed = await openCommandAt({
        command,
        target,
        title: paneTitle(planned),
        workspaceName: candidate.project,
        cwd: candidate.cwd,
        enter: opts.enter,
    });
    prof.summary("open-session");

    return {
        sessionId: candidate.sessionId,
        command,
        workspaceRef: placed.workspaceRef,
        surfaceRef: placed.surfaceRef,
        target: target.kind,
    };
}
