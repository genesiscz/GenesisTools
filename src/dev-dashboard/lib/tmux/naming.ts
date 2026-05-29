import { makeStandaloneTmuxSessionName } from "@app/utils/tmux/naming";

export { DEV_DASHBOARD_WORKSPACE } from "@app/dev-dashboard/lib/tmux/constants";

export function makeTtydTmuxSessionName(id: string): string {
    return `dev-dashboard-${id.slice(0, 8)}`;
}

export function makeCmuxTmuxSessionName(): string {
    return makeStandaloneTmuxSessionName("dev-dashboard-cmux");
}
