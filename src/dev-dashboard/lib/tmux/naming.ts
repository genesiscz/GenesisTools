import { makeStandaloneTmuxSessionName } from "@genesiscz/utils/tmux/naming";

export { DEV_DASHBOARD_WORKSPACE } from "@app/dev-dashboard/lib/tmux/constants";

/** Short default for ttyd-spawned sessions — was `dev-dashboard-<8hex>`, now `dd-<8hex>`. */
export function makeTtydTmuxSessionName(id: string): string {
    return `dd-${id.slice(0, 8)}`;
}

export function makeCmuxTmuxSessionName(): string {
    return makeStandaloneTmuxSessionName("dd-cmux");
}
