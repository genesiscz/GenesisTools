import { attachTmuxToCmux } from "@app/utils/cmux/send-tmux";
import type { AttachTmuxResult, CmuxSendTarget, DashboardSendTarget } from "@app/utils/cmux/types";
import { DEV_DASHBOARD_WORKSPACE } from "@app/dev-dashboard/lib/tmux/constants";

export function resolveDashboardSendTarget(target: DashboardSendTarget): CmuxSendTarget {
    if (target.mode === "quick_dev_dashboard") {
        return { mode: "workspace_by_name", workspaceName: DEV_DASHBOARD_WORKSPACE };
    }

    return target;
}

export async function sendTmuxSessionToCmux({
    tmuxSessionName,
    target,
    cwd,
}: {
    tmuxSessionName: string;
    target: DashboardSendTarget;
    cwd?: string;
}): Promise<AttachTmuxResult> {
    return attachTmuxToCmux({
        tmuxSessionName,
        target: resolveDashboardSendTarget(target),
        cwd,
    });
}
