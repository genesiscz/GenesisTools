import { randomUUID } from "node:crypto";

export { DEV_DASHBOARD_WORKSPACE } from "@app/dev-dashboard/lib/tmux/constants";

export function makeTtydTmuxSessionName(id: string): string {
    return `dev-dashboard-${id.slice(0, 8)}`;
}

export function makeCmuxTmuxSessionName(): string {
    return `dev-dashboard-cmux-${randomUUID().slice(0, 8)}`;
}
