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

it("stages the whole set for a multiple decision and the single letter for a single one", async () => {
    picks.length = 0;
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { gcTime: 0 } } });
    const base = fixtureQueue().sessions[0].items.find((item) => item.kind === "decision")!;
    if (base.kind !== "decision") {
        throw new Error("Expected a decision fixture");
    }
    const mountWith = (decision: typeof base) =>
        render(
            createElement(QueryClientProvider, { client: queryClient },
                createElement(KeptEditsContext.Provider, { value: keptEdits() },
                    createElement(DecisionCard, { session: "session", decision, registerFlush: () => {} })))
        );
    const idOf = (decision: typeof base, option: string) =>
        `answer-queue-decision-session-${decision.number}-option-${option}`;

    const choices = ["a", "b", "c"].map((id) => ({ id, label: `Option ${id}`, rationale: null, recommended: false }));
    const several = { ...base, choices, multiple: true, draftOption: "a" };
    const card = await mountWith(several);
    await fireEvent.press(card.getByTestId(idOf(several, "c")));
    await fireEvent.press(card.getByTestId(idOf(several, "a")));
    expect(picks).toEqual(["ac", ""]);
    expect(card.getByTestId(idOf(several, "a")).props.accessibilityRole).toBe("checkbox");
    await card.unmount();

    picks.length = 0;
    const single = { ...base, choices, multiple: false, draftOption: "a" };
    const singleCard = await mountWith(single);
    await fireEvent.press(singleCard.getByTestId(idOf(single, "c")));
    expect(picks).toEqual(["c"]);
    expect(singleCard.getByTestId(idOf(single, "c")).props.accessibilityRole).toBe("button");
    await singleCard.unmount();
    queryClient.clear();
});

it("shows the decision's context, proposal, reasoning and each option's rationale before the user picks", async () => {
    const queryClient = new QueryClient();
    const base = fixtureQueue().sessions[0].items.find((item) => item.kind === "decision")!;
    if (base.kind !== "decision") {
        throw new Error("Expected a decision fixture");
    }
    const decision = {
        ...base,
        context: "The cache holds 2 GB.",
        proposal: "Drop the cold half.",
        reasoning: "Reads touch only the newest week.",
        choices: [
            { id: "a", label: "Drop it", rationale: "Frees 1 GB now.", recommended: true },
            { id: "b", label: "Keep it", rationale: null, recommended: false },
        ],
    };
    const card = await render(
        createElement(QueryClientProvider, { client: queryClient },
            createElement(KeptEditsContext.Provider, { value: keptEdits() },
                createElement(DecisionCard, { session: "session", decision, registerFlush: () => {} })))
    );
    const id = `answer-queue-decision-session-${decision.number}`;
    const text = (testID: string) => card.getByTestId(testID).props.children[1].props.children;

    expect(text(`${id}-context`)).toBe("The cache holds 2 GB.");
    expect(text(`${id}-proposal`)).toBe("Drop the cold half.");
    expect(text(`${id}-reasoning`)).toBe("Reads touch only the newest week.");
    expect(card.getByTestId(`${id}-option-a-rationale`).props.children).toBe("Frees 1 GB now.");
    expect(card.queryByTestId(`${id}-option-b-rationale`)).toBeNull();
    await card.unmount();
    queryClient.clear();
});

it("keeps the options disabled until the queue shows the staged set, so the next tap toggles from fresh data", async () => {
    picks.length = 0;
    const { useQuery } = await import("@tanstack/react-query");
    const { answerQueueKeys } = await import("@/features/answer-queue/queries");
    const { waitFor } = await import("@testing-library/react-native/pure");
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { gcTime: 0 } } });
    const base = fixtureQueue().sessions[0].items.find((item) => item.kind === "decision")!;
    if (base.kind !== "decision") {
        throw new Error("Expected a decision fixture");
    }
    const choices = ["a", "b", "c"].map((id) => ({ id, label: `Option ${id}`, rationale: null, recommended: false }));
    // The Mac's copy of the decision: its staged set is the last pick the stage door took.
    const server = { ...base, choices, multiple: true, draftOption: null as string | null };
    let gate: Promise<void> = Promise.resolve();
    let release = () => {};
    function Host() {
        const { data } = useQuery({
            queryKey: answerQueueKeys.queue,
            queryFn: async () => {
                await gate;
                return { ...server, draftOption: picks.at(-1) || null };
            },
        });
        return data ? createElement(DecisionCard, { session: "session", decision: data, registerFlush: () => {} }) : null;
    }
    const card = await render(createElement(QueryClientProvider, { client: queryClient }, createElement(Host)));
    const option = (id: string) => card.getByTestId(`answer-queue-decision-session-${server.number}-option-${id}`);
    await waitFor(() => expect(option("a")).toBeDefined());

    // The stage resolves at once; the refetch that shows it waits.
    gate = new Promise((resolve) => {
        release = resolve;
    });
    await fireEvent.press(option("a"));
    await act(async () => {
        await Bun.sleep(5);
    });
    expect(picks).toEqual(["a"]);
    expect(option("c").props.disabled).toBe(true);

    await act(async () => {
        release();
        await Bun.sleep(5);
    });
    await waitFor(() => expect(option("c").props.disabled).toBe(false));
    expect(option("a").props.accessibilityState.checked).toBe(true);
    await fireEvent.press(option("c"));
    expect(picks).toEqual(["a", "ac"]);
    await card.unmount();
    queryClient.clear();
});
