import { afterEach, expect, it, mock } from "bun:test";
import { createElement, type ReactNode } from "react";
mock.module("react-native", () => ({
    View: "View", Text: "Text", TextInput: "TextInput", Pressable: "View",
    StyleSheet: { flatten: (style: unknown) => style ?? {} },
}));
mock.module("expo-router", () => ({ useIsFocused: () => true }));
mock.module("expo-sqlite/kv-store", () => ({ default: { getItem: async () => null, setItem: async () => {} } }));
mock.module("@/live/provider", () => ({ useLiveRefetchInterval: () => false }));
mock.module("@/state/connection-store", () => ({
    useConnectionStore: (select: (state: { activeId: string }) => unknown) => select({ activeId: "mac-a" }),
}));
let outcome = "delivered";
let unavailable = false;
const keys: string[] = [];
mock.module("@/api/client-provider", () => ({
    useDashboardClient: () => client,
}));
const client = {
    call: async (_endpoint: unknown, _input: unknown, options: { idempotencyKey: string }) => {
        keys.push(options.idempotencyKey);
        if (unavailable) {
            throw new Error("send -> 503: unavailable");
        }
        if (outcome === "error") {
            throw new Error("send -> 400: refused");
        }
        return { key: "session", outcome, timing: "now", route: "claude-peer", detail: "fixture" };
    },
};
const { act, cleanup, renderHook } = await import("@testing-library/react-native/pure");
const { QueryClient, QueryClientProvider, onlineManager } = await import("@tanstack/react-query");
const { memoryDraftStore } = await import("./outbox");
const { useSteerComposer } = await import("./hooks");
afterEach(cleanup);

it("retries a sleeping Mac on agent query recovery with the original key while the phone stays online", async () => {
    const store = memoryDraftStore();
    const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
    onlineManager.setOnline(true);
    keys.length = 0;
    unavailable = true;
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: queryClient }, children);
    const hook = await renderHook(() => useSteerComposer("session", store), { wrapper });
    await act(async () => { expect(await hook.result.current.submit("hello", "now")).toBe(true); });
    const [draft] = await store.read();
    expect(draft?.text).toBe("hello");
    unavailable = false;
    outcome = "delivered";
    await act(async () => { queryClient.setQueryData(["agents", "board"], { sessions: [] }); });
    expect(await store.read()).toEqual([]);
    expect(keys).toEqual([draft!.id, draft!.id]);
    await hook.unmount();
    queryClient.clear();
});

it("reports acceptance only for delivered or queued sends, retaining refused and failed submissions", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
    const store = memoryDraftStore();
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: queryClient }, children);
    const hook = await renderHook(() => useSteerComposer("session", store), { wrapper });
    unavailable = false;
    for (const [next, accepted] of [["delivered", true], ["queued-session", true], ["refused", false], ["unknown", true], ["error", false]] as const) {
        outcome = next;
        await act(async () => { expect(await hook.result.current.submit("hello", "now")).toBe(accepted); });
    }
    await hook.unmount();
    queryClient.clear();
});
