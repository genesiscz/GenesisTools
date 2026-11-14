import { afterEach, expect, it, mock } from "bun:test";
import type { AgentBoardSession } from "@dd/contract";
import { createElement, type ReactNode } from "react";
mock.module("react-native", () => ({
    View: "View", Text: "Text", TextInput: "TextInput", Pressable: "View",
    StyleSheet: { flatten: (style: unknown) => style ?? {} },
}));
mock.module("expo-router", () => ({ useIsFocused: () => true }));
mock.module("expo-sqlite/kv-store", () => ({ default: { getItem: async () => null, setItem: async () => {} } }));
mock.module("@/live/provider", () => ({ useLiveRefetchInterval: () => false }));
let outcome = "delivered";
let unavailable = false;
const keys: string[] = [];
let watches: { key: string }[] = [];
mock.module("@/api/client-provider", () => ({
    useDashboardClient: () => client,
    useDashboardConnectionId: () => "mac-a",
}));
const { ENDPOINTS } = await import("@dd/contract");
const client = {
    call: async (endpoint: unknown, _input: unknown, options?: { idempotencyKey: string }) => {
        if (endpoint === ENDPOINTS.gatewayPings) {
            return { watches };
        }
        keys.push(options?.idempotencyKey ?? "");
        if (unavailable) {
            throw new Error("send -> 503: unavailable");
        }
        if (outcome === "error") {
            throw new Error("send -> 400: refused");
        }
        return { key: "session", outcome, timing: "now", route: "claude-peer", detail: "fixture" };
    },
};
const { act, cleanup, renderHook, waitFor } = await import("@testing-library/react-native/pure");
const { QueryClient, QueryClientProvider, onlineManager } = await import("@tanstack/react-query");
const { memoryDraftStore } = await import("./outbox");
const { BOARD_METADATA_MS, boardRefetchInterval, useOutboxDrain, usePingWatch, useSteerComposer } = await import("./hooks");
afterEach(cleanup);

function countingStore(failWrites = 0) {
    const inner = memoryDraftStore();
    let failures = failWrites;
    const store = {
        writes: 0,
        read: inner.read,
        write: async (drafts: Awaited<ReturnType<typeof inner.read>>) => {
            if (failures > 0) {
                failures--;
                throw new Error("the phone's storage is full");
            }
            store.writes++;
            await inner.write(drafts);
        },
    };
    return store;
}

function setup() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: 0, retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: queryClient }, children);
    return { queryClient, wrapper };
}

it("retries a sleeping Mac on board recovery with the original key, after the session screen closed", async () => {
    const store = memoryDraftStore();
    const { queryClient, wrapper } = setup();
    onlineManager.setOnline(true);
    keys.length = 0;
    unavailable = true;
    const drain = await renderHook(() => useOutboxDrain(store), { wrapper });
    const composer = await renderHook(() => useSteerComposer("session", store), { wrapper });
    await act(async () => { expect(await composer.result.current.submit("hello", "now")).toBe(true); });
    const [draft] = await store.read();
    expect(draft?.text).toBe("hello");
    await composer.unmount();
    unavailable = false;
    outcome = "delivered";
    await act(async () => { queryClient.setQueryData(["agents", "board"], { sessions: [] }); });
    await waitFor(async () => expect(await store.read()).toEqual([]));
    expect(keys).toEqual([draft!.id, draft!.id]);
    await drain.unmount();
    queryClient.clear();
});

it("reads the outbox but never rewrites it on a transcript poll or a board update with nothing waiting", async () => {
    const store = countingStore();
    const { queryClient, wrapper } = setup();
    onlineManager.setOnline(true);
    const drain = await renderHook(() => useOutboxDrain(store), { wrapper });
    const composer = await renderHook(() => useSteerComposer("session", store), { wrapper });
    await act(async () => {
        queryClient.setQueryData(["agents", "transcript", "session"], { turns: [] });
        queryClient.setQueryData(["agents", "board"], { sessions: [] });
    });
    expect(store.writes).toBe(0);
    await composer.unmount();
    await drain.unmount();
    queryClient.clear();
});

it("reports acceptance only for delivered or queued sends, retaining refused and failed submissions", async () => {
    const { queryClient, wrapper } = setup();
    const store = memoryDraftStore();
    const hook = await renderHook(() => useSteerComposer("session", store), { wrapper });
    unavailable = false;
    for (const [next, accepted] of [["delivered", true], ["queued-session", true], ["refused", false], ["unknown", true], ["error", false]] as const) {
        outcome = next;
        await act(async () => { expect(await hook.result.current.submit("hello", "now")).toBe(accepted); });
    }
    await hook.unmount();
    queryClient.clear();
});

it("keeps an uncertain send out of the replay queue when the phone cannot save it, and says so", async () => {
    const { queryClient, wrapper } = setup();
    const store = countingStore(1);
    onlineManager.setOnline(true);
    unavailable = false;
    outcome = "unknown";
    const hook = await renderHook(() => useSteerComposer("session", store), { wrapper });
    await act(async () => { expect(await hook.result.current.submit("hello", "now")).toBe(false); });
    expect((await store.read()).filter((draft) => !draft.blocked)).toEqual([]);
    expect(hook.result.current.result).toEqual({ kind: "failed", error: "Not saved on the phone: the phone's storage is full" });
    await hook.unmount();
    queryClient.clear();
});

it("reads the ping watches again when the session's turn ends, so a consumed watch is not shown as set", async () => {
    const { queryClient, wrapper } = setup();
    watches = [{ key: "session" }];
    const session = { key: "session", label: "working", title: null, project: "demo" } as unknown as AgentBoardSession;
    const hook = await renderHook((current: AgentBoardSession) => usePingWatch(current), { wrapper, initialProps: session });
    await waitFor(() => expect(hook.result.current.watched).toBe(true));
    watches = [];
    await hook.rerender({ ...session, label: "idle" } as AgentBoardSession);
    await waitFor(() => expect(hook.result.current.watched).toBe(false));
    await hook.unmount();
    queryClient.clear();
});

it("keeps a slow board refresh while the live channel is up, and the fallback poll while it is down", () => {
    expect(boardRefetchInterval(false)).toBe(BOARD_METADATA_MS);
    expect(boardRefetchInterval(15_000)).toBe(15_000);
});
