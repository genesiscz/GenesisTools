import * as Notifications from "expo-notifications";
import type { Href } from "expo-router";
import { create } from "zustand";

/**
 * The screens a notification may open with a plain tap, by its `data.open` value. A notice can come from the Mac, so
 * only a route listed here is opened; anything else opens the app where it was. The Friday timesheet reminder
 * (`features/timesheet/reminder.ts`) is the one that asks for a screen today.
 */
const TAP_ROUTES: Readonly<Record<string, Href>> = {
    "/timesheet": "/timesheet",
};

/** The screen a plain tap on a notice asks for; null for an answer button or a notice that names no known screen. */
export function routeOfTap(response: Notifications.NotificationResponse): Href | null {
    if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) {
        return null;
    }

    const data: unknown = response.notification.request.content.data;
    const open = typeof data === "object" && data !== null ? Reflect.get(data, "open") : undefined;
    return typeof open === "string" && Object.hasOwn(TAP_ROUTES, open) ? TAP_ROUTES[open] : null;
}

interface OpenRouteState {
    /** The screen a tap asked for, waiting until the app can navigate. */
    route: Href | null;
    queue: (route: Href) => void;
    take: () => Href | null;
}

export const useOpenRouteStore = create<OpenRouteState>((set, get) => ({
    route: null,
    queue: (route) => set({ route }),
    take: () => {
        const route = get().route;
        set({ route: null });
        return route;
    },
}));

/**
 * Keeps the screen a plain tap asked for. A tap can launch the app, so the push listener (registered before React
 * mounts) only queues it; `useOpenQueuedRoute` (`use-open-queued-route.ts`) opens it once a Mac is connected and the
 * navigator is ready. That hook lives apart because this module loads with the push listener, before the router.
 */
export function queueTappedRoute(response: Notifications.NotificationResponse): void {
    const route = routeOfTap(response);

    if (route) {
        useOpenRouteStore.getState().queue(route);
    }
}
