import { afterEach, expect, it, mock } from "bun:test";

mock.module("react-native", () => ({ View: "View", Text: "Text" }));
mock.module("expo-secure-store", () => ({
    getItemAsync: async () => null,
    setItemAsync: async () => {},
    deleteItemAsync: async () => {},
}));
mock.module("@/api/client-provider", () => ({
    useDashboardClient: () => ({}),
    useDashboardConnectionId: () => null,
    useIsMockClient: () => false,
}));

const { cleanup, renderHook, waitFor } = await import("@testing-library/react-native/pure");
const { useWakeDeadline } = await import("./hooks");
afterEach(cleanup);

it("ends the wait by its own timer while nothing else renders the screen", async () => {
    const sentAt = Date.now();
    const hook = await renderHook(() => useWakeDeadline(sentAt, 30));
    expect(hook.result.current).toEqual({ waiting: true, expired: false });
    await waitFor(() => expect(hook.result.current).toEqual({ waiting: false, expired: true }));
});

it("does not wait before a wake was sent", async () => {
    const hook = await renderHook(() => useWakeDeadline(null, 30));
    expect(hook.result.current).toEqual({ waiting: false, expired: false });
});
