import { useQuery } from "@tanstack/react-query";
import * as Notifications from "expo-notifications";
import { useEffect } from "react";
import { useDashboardClient, useIsMockClient } from "@/api/client-provider";
import { useIconBadgeStore } from "@/features/glance/badge-mode";
import { badgeNumber, glanceQuery } from "@/features/glance/queries";

/**
 * The app icon's badge (F18): the waiting count from the Mac's glance, decisions, forms, open dialogs and tool calls
 * that wait for allow or deny. The `dd.iconBadge` setting (Notifications screen) turns it off; off clears the badge
 * at once. Nothing is written until that setting is read, so a badge the user turned off never flashes on a start.
 * Renders nothing.
 */
export function GlanceBadge() {
    const client = useDashboardClient();
    const mode = useIconBadgeStore((state) => state.mode);
    const load = useIconBadgeStore((state) => state.load);
    const mock = useIsMockClient();
    const glance = useQuery({ ...glanceQuery(client), enabled: !mock && mode === "waiting" });
    const count = mode === null ? null : mock ? 0 : badgeNumber(glance.data, mode);

    useEffect(() => {
        void load();
    }, [load]);

    useEffect(() => {
        if (count === null) {
            return;
        }

        void Notifications.setBadgeCountAsync(count).catch((err: unknown) => {
            console.warn("[glance] badge not set", err);
        });
    }, [count]);

    return null;
}
