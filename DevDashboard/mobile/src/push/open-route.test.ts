import { describe, expect, it, mock } from "bun:test";

mock.module("expo-notifications", () => ({ DEFAULT_ACTION_IDENTIFIER: "expo.modules.notifications.actions.DEFAULT" }));

const { queueTappedRoute, routeOfTap, useOpenRouteStore } = await import("@/push/open-route");

function tap(actionIdentifier: string, data: Record<string, unknown>) {
    return {
        actionIdentifier,
        notification: { request: { identifier: "n1", content: { data } } },
    } as unknown as Parameters<typeof routeOfTap>[0];
}

const PLAIN = "expo.modules.notifications.actions.DEFAULT";

describe("a notification tap that names a screen", () => {
    it("opens only a known in-app screen, and only for a plain tap", () => {
        expect(routeOfTap(tap(PLAIN, { open: "/timesheet" }))).toBe("/timesheet");
        expect(routeOfTap(tap("answer-a", { open: "/timesheet" }))).toBeNull();
        expect(routeOfTap(tap(PLAIN, { open: "https://example.com" }))).toBeNull();
        expect(routeOfTap(tap(PLAIN, { open: "/settings" }))).toBeNull();
        expect(routeOfTap(tap(PLAIN, { open: "toString" }))).toBeNull();
        expect(routeOfTap(tap(PLAIN, {}))).toBeNull();
    });

    it("waits in the queue until the app takes it, once", () => {
        queueTappedRoute(tap(PLAIN, { open: "/timesheet" }));
        expect(useOpenRouteStore.getState().route).toBe("/timesheet");
        expect(useOpenRouteStore.getState().take()).toBe("/timesheet");
        expect(useOpenRouteStore.getState().take()).toBeNull();

        queueTappedRoute(tap("answer-a", { open: "/timesheet" }));
        expect(useOpenRouteStore.getState().route).toBeNull();
    });
});
