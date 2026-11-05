import { afterEach, expect, it, mock } from "bun:test";
import { createElement } from "react";

// Bun cannot parse React Native's Flow entry point; retain props and children on host nodes.
mock.module("react-native", () => ({
    View: "View",
    Text: "Text",
    TextInput: "TextInput",
    Pressable: "View",
    StyleSheet: { flatten: (style: unknown) => style ?? {} },
    AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) },
}));
mock.module("expo-router", () => ({ useIsFocused: () => true }));
mock.module("@/live/provider", () => ({ useLiveRefetchInterval: () => false }));

const picks: string[] = [];
mock.module("@/api/client-provider", () => ({
    useDashboardClient: () => ({
        call: async (_endpoint: unknown, input: { option: string }) => {
            picks.push(input.option);
            if (input.option === "b") {
                throw new Error("Mac refused pick b");
            }
            return {};
        },
    }),
}));

const { act, cleanup, fireEvent, render } = await import("@testing-library/react-native/pure");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { KeptEditsContext } = await import("@/features/answer-queue/hooks");
const { keptEdits } = await import("@/features/answer-queue/units");
const { DecisionCard } = await import("./DecisionCard");
const { fixtureQueue } = await import("@/api/fixtures/queue");

afterEach(cleanup);

it("keeps a refused pick blocking Send across card unmount and remount until a pick succeeds", async () => {
    picks.length = 0;
    const kept = keptEdits();
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { gcTime: 0 } } });
    const decision = fixtureQueue().sessions[0].items.find((item) => item.kind === "decision")!;
    if (decision.kind !== "decision") {
        throw new Error("Expected a decision fixture");
    }
    const flushes = new Map<number, () => Promise<void>>();
    const registerFlush = (number: number, flush: (() => Promise<void>) | null) => {
        if (flush) {
            flushes.set(number, flush);
        } else {
            flushes.delete(number);
        }
    };
    const flush = () => {
        const registered = flushes.get(decision.number);
        expect(registered).toBeDefined();
        return registered!();
    };
    const mount = () => render(
        createElement(QueryClientProvider, { client: queryClient },
            createElement(KeptEditsContext.Provider, { value: kept },
                createElement(DecisionCard, { session: "session", decision, registerFlush })))
    );
    let card = await mount();
    const pick = async (option: string) => {
        await fireEvent.press(card.getByTestId(`answer-queue-decision-session-${decision.number}-option-${option}`));
    };

    await pick("a");
    await act(async () => { await expect(flush()).resolves.toBeUndefined(); });
    await pick("b");
    await act(async () => { await expect(flush()).rejects.toThrow("Mac refused pick b"); });

    await card.unmount();
    expect(flushes.size).toBe(0);
    card = await mount();
    await act(async () => { await expect(flush()).rejects.toThrow("Mac refused pick b"); });
    // The remounted card's mutation has no error: the kept tracker's refusal is what tells the user why Send waits.
    const errorId = `answer-queue-decision-session-${decision.number}-error`;
    expect(card.getByTestId(errorId).props.children).toBe("Mac refused pick b");

    await pick("a");
    await act(async () => { await expect(flush()).resolves.toBeUndefined(); });
    expect(card.queryByTestId(errorId)).toBeNull();
    expect(picks).toEqual(["a", "b", "a"]);
    await card.unmount();
    queryClient.clear();
});
