import { afterEach, expect, it, mock } from "bun:test";
import type { PrTriageRowDto } from "@dd/contract";
import { createElement } from "react";

type AlertButton = { style?: string; onPress?: () => void };
mock.module("react-native", () => ({
    View: "View",
    Text: "Text",
    Pressable: "View",
    ActivityIndicator: "ActivityIndicator",
    StyleSheet: { flatten: (style: unknown) => style ?? {} },
    // The test confirms the merge dialog at once.
    Alert: { alert: (_title: string, _body: string, buttons: AlertButton[]) => buttons.find((b) => b.style === "destructive")?.onPress?.() },
}));
mock.module("expo-linking", () => ({ openURL: async () => true }));
mock.module("@/theme/colors", () => ({ useThemeColors: () => ({}) }));
mock.module("@/lib/face-id", () => ({ confirmWithFaceId: async () => ({ ok: true }) }));
let checksFail = true;
const lines = Array.from({ length: 30 }, (_, index) => `step line ${index}`);
const { ENDPOINTS } = await import("@dd/contract");
mock.module("@/api/client-provider", () => ({
    useDashboardClient: () => ({
        call: async (endpoint: unknown) => {
            if (endpoint === ENDPOINTS.gatewayPrChecks) {
                if (checksFail) {
                    throw new Error("checks -> 502: bad gateway");
                }
                return { url: "u", checks: [], failing: { name: "test", url: "https://example.com/run/1", lines, error: null } };
            }
            return { merged: true, method: "rebase", detail: "" };
        },
    }),
}));

const { cleanup, fireEvent, render, waitFor } = await import("@testing-library/react-native/pure");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { PrDetail } = await import("./PrRow");
afterEach(cleanup);

const pr = {
    url: "https://example.com/pr/7",
    number: 7,
    repo: "demo/app",
    title: "Fix the build",
    provider: "github",
    reasons: [],
    unresolved: 0,
    checkout: "/tmp/demo",
} as unknown as PrTriageRowDto;

function mount(onMergeLine: (line: { text: string; ok: boolean }) => void) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    return render(createElement(QueryClientProvider, { client: queryClient }, createElement(PrDetail, { pr, onMergeLine })));
}

it("shows a failed checks lookup with a retry, then the whole failing log on request", async () => {
    checksFail = true;
    const view = await mount(() => {});
    await waitFor(() => expect(view.getByTestId("pr-checks-error")).toBeTruthy());
    checksFail = false;
    await fireEvent.press(view.getByTestId("pr-checks-retry"));
    await waitFor(() => expect(view.getByTestId("pr-failing-log").props.numberOfLines).toBe(14));
    await fireEvent.press(view.getByTestId("pr-log-toggle"));
    expect(view.getByTestId("pr-failing-log").props.numberOfLines).toBeUndefined();
});

it("hands the merge receipt to the screen, since the merged PR leaves the list", async () => {
    checksFail = false;
    const merged: { text: string; ok: boolean }[] = [];
    const view = await mount((line) => merged.push(line));
    await fireEvent.press(view.getByTestId("btn-pr-merge-rebase"));
    await waitFor(() => expect(merged).toEqual([{ text: "demo/app#7 merged (rebase).", ok: true }]));
    expect(view.queryByTestId("pr-receipt")).toBeNull();
});
