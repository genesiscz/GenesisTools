import { useQuery } from "@tanstack/react-query";
import * as Notifications from "expo-notifications";
import { useEffect, useState } from "react";
import { useDashboardClient } from "@/api/client-provider";
import { badgeNumber, glanceQuery, type IconBadgeMode } from "@/features/glance/queries";
import { getPref } from "@/lib/storage/kv";

/**
 * The app icon's badge (F18): the waiting count from the Mac's glance, decisions, forms, open dialogs and tool calls
 * that wait for allow or deny. The `dd.iconBadge` setting (Notifications screen) turns it off; off clears the badge.
 * Renders nothing.
 */
export function GlanceBadge() {
    const client = useDashboardClient();
    const [mode, setMode] = useState<IconBadgeMode>("waiting");
    const glance = useQuery(glanceQuery(client));
    const count = badgeNumber(glance.data, mode);

    useEffect(() => {
        void getPref("dd.iconBadge").then((saved) => setMode(saved ?? "waiting"));
    }, []);

    useEffect(() => {
        void Notifications.setBadgeCountAsync(count).catch(() => undefined);
    }, [count]);

    return null;
}
