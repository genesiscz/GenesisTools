import { runCmuxJSON } from "@genesiscz/utils/cmux/lib/cli";
import { focusCmuxPane } from "@genesiscz/utils/cmux/lib/controls";
import { withFocusedWorkspace } from "@genesiscz/utils/cmux/lib/focus-guard";
import { sameCmuxId } from "@genesiscz/utils/cmux/lib/target";
import type { AttachTmuxResult, CmuxSendTarget } from "@genesiscz/utils/cmux/types";
import {
    assertTerminalSurface,
    ensureWorkspaceByName,
    openSplitInWorkspace,
    openSurfaceInPane,
    renameSurfaceTab,
    sendAttachCommand,
} from "@genesiscz/utils/cmux/workspace";
import { logger } from "@genesiscz/utils/logger";
import { sessionExists } from "@genesiscz/utils/tmux/sessions";

export interface AttachTmuxToCmuxOptions {
    tmuxSessionName: string;
    target: CmuxSendTarget;
    cwd?: string;
    focus?: boolean;
}

/** The pane UUID holding the surface with UUID `surfaceId`, which must be a terminal. */
async function resolveSurfaceForExisting(
    workspaceId: string,
    surfaceId: string
): Promise<{ paneId: string; surfaceId: string }> {
    const panes = await runCmuxJSON<{ panes?: Array<{ id?: string; surface_ids?: string[] }> }>([
        "list-panes",
        "--workspace",
        workspaceId,
    ]);

    for (const pane of panes.panes ?? []) {
        if (!pane.id) {
            continue;
        }

        if ((pane.surface_ids ?? []).some((id) => sameCmuxId(id, surfaceId))) {
            await assertTerminalSurface(workspaceId, pane.id, surfaceId);
            return { paneId: pane.id, surfaceId };
        }
    }

    throw new Error(`Surface ${surfaceId} not found in workspace ${workspaceId}`);
}

async function finalizeAttach(
    workspaceId: string,
    paneId: string,
    surfaceId: string,
    tmuxSessionName: string,
    focus: boolean
): Promise<AttachTmuxResult> {
    if (focus) {
        await focusCmuxPane({ workspaceId, paneId });
    }

    try {
        await renameSurfaceTab(workspaceId, surfaceId, tmuxSessionName);
    } catch (error) {
        logger.debug(
            { error, workspaceId, surfaceId, tmuxSessionName },
            "cmux surface tab rename failed (best-effort)"
        );
    }

    return { workspaceId, paneId, surfaceId, tmuxSessionName };
}

/** Attach an existing tmux session at the requested cmux destination, preserving explicit focus behavior. */
export async function attachTmuxToCmux({
    tmuxSessionName,
    target,
    cwd,
    focus = true,
}: AttachTmuxToCmuxOptions): Promise<AttachTmuxResult> {
    if (!(await sessionExists(tmuxSessionName))) {
        throw new Error(`tmux session ${tmuxSessionName} does not exist`);
    }

    let workspaceId: string;
    let paneId: string;
    let surfaceId: string;

    if (target.mode === "workspace_by_name") {
        workspaceId = await ensureWorkspaceByName(target.workspaceName, cwd);
        const opened = await openSplitInWorkspace(workspaceId);
        paneId = opened.paneId;
        surfaceId = opened.surfaceId;
    } else if (target.mode === "new_split") {
        workspaceId = target.workspaceId;
        const opened = await openSplitInWorkspace(workspaceId);
        paneId = opened.paneId;
        surfaceId = opened.surfaceId;
    } else if (target.mode === "new_surface") {
        workspaceId = target.workspaceId;
        paneId = target.paneId;
        const opened = await openSurfaceInPane(workspaceId, paneId);
        surfaceId = opened.surfaceId;
    } else {
        workspaceId = target.workspaceId;
        const resolved = await resolveSurfaceForExisting(workspaceId, target.surfaceId);
        paneId = resolved.paneId;
        surfaceId = resolved.surfaceId;

        await withFocusedWorkspace(workspaceId, async () => {
            await sendAttachCommand({ workspaceId, surfaceId, tmuxSessionName });
        });

        return finalizeAttach(workspaceId, paneId, surfaceId, tmuxSessionName, focus);
    }

    await sendAttachCommand({ workspaceId, surfaceId, tmuxSessionName });

    return finalizeAttach(workspaceId, paneId, surfaceId, tmuxSessionName, focus);
}
