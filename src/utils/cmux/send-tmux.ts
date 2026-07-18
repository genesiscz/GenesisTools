import { runCmuxJSON } from "@genesiscz/utils/cmux/lib/cli";
import { focusCmuxPane } from "@genesiscz/utils/cmux/lib/controls";
import { withFocusedWorkspace } from "@genesiscz/utils/cmux/lib/focus-guard";
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

async function resolveSurfaceForExisting(
    workspaceId: string,
    surfaceId: string
): Promise<{ paneId: string; surfaceId: string }> {
    const panes = await runCmuxJSON<{ panes?: Array<{ ref?: string; surface_refs?: string[] }> }>([
        "list-panes",
        "--workspace",
        workspaceId,
    ]);

    for (const pane of panes.panes ?? []) {
        if (!pane.ref) {
            continue;
        }

        const refs = pane.surface_refs ?? [];

        if (refs.includes(surfaceId)) {
            await assertTerminalSurface(workspaceId, pane.ref, surfaceId);
            return { paneId: pane.ref, surfaceId };
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

export async function attachTmuxToCmux({
    tmuxSessionName,
    target,
    cwd,
    focus = true,
}: AttachTmuxToCmuxOptions): Promise<AttachTmuxResult> {
    if (!sessionExists(tmuxSessionName)) {
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
            await sendAttachCommand({ workspaceRef: workspaceId, surfaceRef: surfaceId, tmuxSessionName });
        });

        return finalizeAttach(workspaceId, paneId, surfaceId, tmuxSessionName, focus);
    }

    await sendAttachCommand({ workspaceRef: workspaceId, surfaceRef: surfaceId, tmuxSessionName });

    return finalizeAttach(workspaceId, paneId, surfaceId, tmuxSessionName, focus);
}
