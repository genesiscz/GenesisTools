import { afterEach, expect, it, mock } from "bun:test";
import { useEffect } from "react";

let onAppState: ((next: string) => void) | null = null;
mock.module("react-native", () => ({
    View: "View",
    Text: "Text",
    AppState: {
        addEventListener: (_event: string, listener: (next: string) => void) => {
            onAppState = listener;
            return { remove: () => {} };
        },
    },
}));
mock.module("expo-router", () => ({
    useFocusEffect: (effect: () => void) => useEffect(effect, [effect]),
}));
mock.module("@/api/client-provider", () => ({ useDashboardClient: () => ({}) }));

const { act, cleanup, renderHook } = await import("@testing-library/react-native/pure");
const { useLocalDay } = await import("./hooks");
afterEach(cleanup);

it("moves to the new day when the app comes back after a week boundary", async () => {
    let today = new Date(2026, 10, 13, 16, 0);
    const now = () => today;
    const hook = await renderHook(() => useLocalDay(now));
    expect(hook.result.current).toBe("2026-11-13");
    today = new Date(2026, 10, 16, 9, 0);
    await act(async () => {
        onAppState?.("active");
    });
    expect(hook.result.current).toBe("2026-11-16");
});
