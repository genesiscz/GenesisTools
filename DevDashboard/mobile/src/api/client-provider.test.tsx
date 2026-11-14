import { afterEach, expect, it, mock } from "bun:test";
import { createElement, type ReactNode } from "react";

mock.module("react-native", () => ({ View: "View", Text: "Text" }));
const fixtureClient = { call: async () => ({}) };
mock.module("@/api/fixture-wire", () => ({ fixtureDashboardClient: fixtureClient }));
const macClient = { call: async () => ({}) };
let state: { transport: { client: () => typeof macClient } | null; activeId: string | null } = {
    transport: null,
    activeId: null,
};
mock.module("@/state/connection-store", () => ({
    useConnectionStore: (select: (current: typeof state) => unknown) => select(state),
}));

const { cleanup, renderHook } = await import("@testing-library/react-native/pure");
const { ClientProvider, useDashboardClient, useDashboardConnectionId } = await import("./client-provider");
afterEach(cleanup);

const wrapper = ({ children }: { children: ReactNode }) => createElement(ClientProvider, null, children);
const useScope = () => ({ client: useDashboardClient(), connectionId: useDashboardConnectionId() });

it("scopes the fixture client to no connection, even when a failed restore left an active id", async () => {
    state = { transport: null, activeId: "mac-a" };
    const hook = await renderHook(useScope, { wrapper });
    expect(Object.is(hook.result.current.client, fixtureClient)).toBe(true);
    expect(hook.result.current.connectionId).toBeNull();
});

it("scopes a live transport's client to the active connection", async () => {
    state = { transport: { client: () => macClient }, activeId: "mac-a" };
    const hook = await renderHook(useScope, { wrapper });
    expect(Object.is(hook.result.current.client, macClient)).toBe(true);
    expect(hook.result.current.connectionId).toBe("mac-a");
});
