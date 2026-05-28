import { describe, expect, test } from "bun:test";
import { resolveDashboardSendTarget } from "@app/dev-dashboard/lib/cmux/send-session";
import { DEV_DASHBOARD_WORKSPACE } from "@app/dev-dashboard/lib/tmux/constants";

describe("resolveDashboardSendTarget", () => {
    test("maps quick_dev_dashboard to workspace_by_name", () => {
        expect(resolveDashboardSendTarget({ mode: "quick_dev_dashboard" })).toEqual({
            mode: "workspace_by_name",
            workspaceName: DEV_DASHBOARD_WORKSPACE,
        });
    });

    test("passes through explicit targets", () => {
        expect(resolveDashboardSendTarget({ mode: "new_split", workspaceId: "workspace:1" })).toEqual({
            mode: "new_split",
            workspaceId: "workspace:1",
        });
    });
});
