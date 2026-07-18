import { DEV_DASHBOARD_WORKSPACE } from "@app/dev-dashboard/lib/tmux/constants";
import { makeCmuxTmuxSessionName } from "@app/dev-dashboard/lib/tmux/naming";
import { focusCmuxPane } from "@genesiscz/utils/cmux/lib/controls";
import { withFocusedWorkspace } from "@genesiscz/utils/cmux/lib/focus-guard";
import type { AttachTmuxResult } from "@genesiscz/utils/cmux/types";
import {
    ensureWorkspaceByName,
    openSplitInWorkspace,
    renameSurfaceTab,
    sendNewSessionCommand,
} from "@genesiscz/utils/cmux/workspace";
import { logger } from "@genesiscz/utils/logger";

export async function createDevDashboardTerminal(opts: { cwd?: string } = {}): Promise<AttachTmuxResult> {
    const cwd = opts.cwd ?? process.cwd();
    const tmuxSessionName = makeCmuxTmuxSessionName();
    const workspaceId = await ensureWorkspaceByName(DEV_DASHBOARD_WORKSPACE, cwd);
    const opened = await openSplitInWorkspace(workspaceId);

    await withFocusedWorkspace(workspaceId, async () => {
        await sendNewSessionCommand({
            workspaceRef: workspaceId,
            surfaceRef: opened.surfaceId,
            tmuxSessionName,
            cwd,
        });
    });

    try {
        await renameSurfaceTab(workspaceId, opened.surfaceId, tmuxSessionName);
    } catch (error) {
        logger.debug(
            { error, workspaceId, surfaceId: opened.surfaceId, tmuxSessionName },
            "cmux surface tab rename failed (best-effort)"
        );
    }

    await focusCmuxPane({ workspaceId, paneId: opened.paneId });

    return {
        workspaceId,
        paneId: opened.paneId,
        surfaceId: opened.surfaceId,
        tmuxSessionName,
    };
}
