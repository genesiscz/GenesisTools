import { router, useRootNavigationState } from "expo-router";
import { useEffect } from "react";
import { useOpenRouteStore } from "@/push/open-route";

/**
 * Opens the screen a notification tap queued. The tabs layout calls it: that layout mounts only behind the connection
 * gate, after the saved connection was restored, so the route opens on a connected app with its navigator in place.
 */
export function useOpenQueuedRoute(): void {
    const route = useOpenRouteStore((state) => state.route);
    const ready = useRootNavigationState()?.key !== undefined;

    useEffect(() => {
        if (!route || !ready) {
            return;
        }

        const next = useOpenRouteStore.getState().take();

        if (next) {
            router.push(next);
        }
    }, [route, ready]);
}
