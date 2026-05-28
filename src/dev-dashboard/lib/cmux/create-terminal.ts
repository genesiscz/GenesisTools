import { focusCmuxPane } from "@app/cmux/lib/controls";
import { withFocusedWorkspace } from "@app/cmux/lib/focus-guard";
import { DEV_DASHBOARD_WORKSPACE } from "@app/dev-dashboard/lib/tmux/constants";
import { makeCmuxTmuxSessionName } from "@app/dev-dashboard/lib/tmux/naming";
import type { AttachTmuxResult } from "@app/utils/cmux/types";
import {
    ensureWorkspaceByName,
    openSplitInWorkspace,
    renameSurfaceTab,
    sendNewSessionCommand,
} from "@app/utils/cmux/workspace";

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
    } catch {
        // best-effort
    }

    await focusCmuxPane({ workspaceId, paneId: opened.paneId });

    return {
        workspaceId,
        paneId: opened.paneId,
        surfaceId: opened.surfaceId,
        tmuxSessionName,
    };
}
