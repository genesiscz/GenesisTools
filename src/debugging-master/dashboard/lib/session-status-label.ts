import type { DashboardSession } from "@app/utils/log-viewer/log-source";
import { formatLastMessageAgo } from "@app/utils/format";

export function formatDashboardSessionStatusLabel({
    session,
    now,
    latestLineTs,
}: {
    session: DashboardSession;
    now: number;
    latestLineTs?: number;
}): string {
    const lastTs = Math.max(session.lastActivityAt, latestLineTs ?? 0);
    const ago = formatLastMessageAgo(Math.max(0, now - lastTs));

    if (session.state === "active") {
        return `active · last message ${ago}`;
    }

    if (session.state === "exited") {
        if (lastTs > 0) {
            return `idle · last message ${ago}`;
        }

        return session.stateLabel;
    }

    return session.stateLabel;
}
