import { buildLaunchCommand, paneTitle } from "@app/claude/lib/cmux/command";
import { findCandidate } from "@app/claude/lib/cmux/sessions";
import type { PlannedSession } from "@app/claude/lib/cmux/types";
import { runCmuxOk } from "@genesiscz/utils/cmux/lib/cli";
import {
    createWorkspaceWithName,
    openSplitInWorkspace,
    openSurfaceInPane,
    pickAnchorSurface,
    renameSurfaceTab,
} from "@genesiscz/utils/cmux/workspace";
import { profiler } from "@genesiscz/utils/profile";

/**
 * Resume a session at a chosen level of the cmux hierarchy:
 *
 * - window    → new workspace in that window
 * - workspace → new pane (split) in that workspace
 * - pane      → new surface (tab) in that pane
 * - surface   → type the resume command into that surface as-is
 *
 * The launch command comes from the same builder restore uses, so the session
 * resumes under the account and auth mode it was pinned to.
 */
export type OpenSessionTarget =
    | { kind: "window"; windowRef: string }
    | { kind: "workspace"; workspaceRef: string }
    | { kind: "pane"; workspaceRef: string; paneRef: string }
    | { kind: "surface"; workspaceRef: string; surfaceRef: string };

export interface OpenSessionResult {
    sessionId: string;
    command: string;
    workspaceRef: string;
    surfaceRef: string;
    target: OpenSessionTarget["kind"];
}

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

    const placed = await prof.measureAsync("place", async (): Promise<{ workspaceRef: string; surfaceRef: string }> => {
        switch (target.kind) {
            case "window": {
                const created = await createWorkspaceWithName({
                    name: candidate.project,
                    cwd: candidate.cwd,
                    window: target.windowRef,
                });
                const anchor = await pickAnchorSurface(created.workspace_ref);
                return { workspaceRef: created.workspace_ref, surfaceRef: anchor.surfaceRef };
            }
            case "workspace": {
                const split = await openSplitInWorkspace(target.workspaceRef);
                return { workspaceRef: target.workspaceRef, surfaceRef: split.surfaceId };
            }
            case "pane": {
                const created = await openSurfaceInPane(target.workspaceRef, target.paneRef);
                return { workspaceRef: target.workspaceRef, surfaceRef: created.surfaceId };
            }
            case "surface":
                return { workspaceRef: target.workspaceRef, surfaceRef: target.surfaceRef };
        }
    });

    // A surface created for the session gets its tab named; an existing surface
    // (kind "surface") keeps whatever title its owner gave it.
    if (target.kind !== "surface") {
        await renameSurfaceTab(placed.workspaceRef, placed.surfaceRef, paneTitle(planned)).catch(() => {});
    }

    const payload = `${command}${(opts.enter ?? true) ? "\n" : ""}`;
    await prof.measureAsync("send", () =>
        runCmuxOk(["send", "--workspace", placed.workspaceRef, "--surface", placed.surfaceRef, payload])
    );
    prof.summary("open-session");

    return {
        sessionId: candidate.sessionId,
        command,
        workspaceRef: placed.workspaceRef,
        surfaceRef: placed.surfaceRef,
        target: target.kind,
    };
}
