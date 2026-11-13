import { expect, it, mock } from "bun:test";
import { createElement } from "react";

// Bun cannot parse React Native's Flow entry point, which the test renderer imports.
mock.module("react-native", () => ({
    View: "View",
    Text: "Text",
    StyleSheet: { flatten: (style: unknown) => style ?? {} },
    AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) },
}));

const badges: number[] = [];
mock.module("expo-notifications", () => ({
    setBadgeCountAsync: async (count: number) => {
        badges.push(count);
        return true;
    },
}));
mock.module("@/api/client-provider", () => ({
    useDashboardClient: () => ({ call: async () => ({ waiting: { total: 4 } }) }),
    useIsMockClient: () => false,
}));

// The saved setting is read slowly, so the Mac's glance answers first.
const prefs = new Map<string, string>([["dd.iconBadge", '"off"']]);
let releasePrefs = () => {};
const prefsRead = new Promise<void>((resolve) => {
    releasePrefs = resolve;
});
mock.module("expo-sqlite/kv-store", () => ({
    default: {
        getItem: async (key: string) => {
            await prefsRead;
            return prefs.get(key) ?? null;
        },
        setItem: async (key: string, value: string) => {
            prefs.set(key, value);
        },
    },
}));

const { act, render } = await import("@testing-library/react-native/pure");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { GlanceBadge } = await import("./GlanceBadge");
const { iconBadgeModeOf, useIconBadgeStore } = await import("./badge-mode");

async function settle() {
    await act(async () => {
        await Bun.sleep(5);
    });
}

it("writes no badge before the saved setting is read, and the switch applies at once", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = await render(createElement(QueryClientProvider, { client: queryClient }, createElement(GlanceBadge)));
    await settle();
    expect(badges).toEqual([]);

    releasePrefs();
    await settle();
    expect(badges).toEqual([0]);

    await act(async () => {
        await useIconBadgeStore.getState().choose("waiting");
        await Bun.sleep(5);
    });
    expect(badges.at(-1)).toBe(4);
    expect(prefs.get("dd.iconBadge")).toBe('"waiting"');

    await act(async () => {
        await useIconBadgeStore.getState().choose("off");
        await Bun.sleep(5);
    });
    expect(badges.at(-1)).toBe(0);
    await view.unmount();
    queryClient.clear();
});

it("reads a missing or unknown stored value as the default", () => {
    expect(iconBadgeModeOf(null)).toBe("waiting");
    expect(iconBadgeModeOf("sometimes")).toBe("waiting");
    expect(iconBadgeModeOf("off")).toBe("off");
});
