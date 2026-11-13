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

/** Every write the cards made, in order; a path with a gate waits until the test opens it. */
const calls: { path: string; input: Record<string, unknown> }[] = [];
const gates = new Map<string, { opened: Promise<void>; open: () => void }>();

function hold(path: string): () => void {
    let open = () => {};
    const opened = new Promise<void>((resolve) => {
        open = resolve;
    });
    gates.set(path, { opened, open });
    return () => {
        gates.delete(path);
        open();
    };
}

mock.module("@/api/client-provider", () => ({
    useDashboardClient: () => ({
        call: async (endpoint: { path: string }, input: Record<string, unknown>) => {
            calls.push({ path: endpoint.path, input });
            await gates.get(endpoint.path)?.opened;
            return endpoint.path === "/api/qa/decisions/send-drafts" ? { delivered: true, uncertain: false } : {};
        },
    }),
}));

const { act, cleanup, fireEvent, render } = await import("@testing-library/react-native/pure");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { KeptEditsContext } = await import("@/features/answer-queue/hooks");
const { keptEdits } = await import("@/features/answer-queue/units");
const { QueueSessionCard } = await import("./QueueSessionCard");
const { fixtureQueue } = await import("@/api/fixtures/queue");

afterEach(async () => {
    for (const gate of gates.values()) {
        gate.open();
    }

    gates.clear();
    // A write a failed test left waiting finishes here, not inside the next test's call list.
    await Bun.sleep(5);
    calls.length = 0;
    await cleanup();
});

type Session = ReturnType<typeof fixtureQueue>["sessions"][number];

async function mount(session: Session) {
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { gcTime: 0 } } });
    const card = await render(
        createElement(QueryClientProvider, { client: queryClient },
            createElement(KeptEditsContext.Provider, { value: keptEdits() },
                createElement(QueueSessionCard, { session, onReceipt: () => {} })))
    );
    return { card, queryClient };
}

async function settle() {
    await act(async () => {
        await Bun.sleep(5);
    });
}

const parserSession = () => fixtureQueue().sessions.find((session) => session.sessionId === "s-parser")!;

it("freezes every decision from the Send tap until the send settles, and sends the note shown at the tap", async () => {
    const base = parserSession();
    const session = {
        ...base,
        items: base.items.map((item) => (item.kind === "decision" && item.number === 4 ? { ...item, draftOption: "a" } : item)),
    };
    const { card } = await mount(session);
    const four = "answer-queue-decision-s-parser-4";
    const five = "answer-queue-decision-s-parser-5";
    const send = "answer-queue-session-s-parser-send";

    await fireEvent.changeText(card.getByTestId(`${four}-note`), "use the old cache");
    const releaseStage = hold("/api/qa/decisions/draft");
    await fireEvent.press(card.getByTestId(`${four}-option-b`));
    await fireEvent.press(card.getByTestId(send));
    await settle();

    // The flush waits for the pick: nothing is editable, on this card or the next one.
    expect(card.getByTestId(`${four}-note`).props.editable).toBe(false);
    expect(card.getByTestId(`${five}-option-a`).props.disabled).toBe(true);
    expect(card.getByTestId(`${five}-note`).props.editable).toBe(false);

    const releaseSend = hold("/api/qa/decisions/send-drafts");
    await act(async () => {
        releaseStage();
        await Bun.sleep(5);
    });
    expect(calls.map((call) => call.input.text ?? call.input.option ?? call.path)).toEqual([
        "b",
        "use the old cache",
        "/api/qa/decisions/send-drafts",
    ]);
    // Still frozen while the send itself is on the way.
    expect(card.getByTestId(`${five}-option-a`).props.disabled).toBe(true);
    expect(card.getByTestId(`${four}-note`).props.editable).toBe(false);

    await act(async () => {
        releaseSend();
        await Bun.sleep(5);
    });
    expect(card.getByTestId(`${five}-option-a`).props.disabled).toBe(false);
    expect(card.getByTestId(`${four}-note`).props.editable).toBe(true);
});

it("freezes a form's choices and text while its answer is on the way", async () => {
    const session = parserSession();
    const { card } = await mount(session);
    const form = "answer-queue-form-ask_fixture";
    const release = hold("/api/qa/pending/:id/answer");

    await fireEvent.press(card.getByTestId(`${form}-q1-a`));
    await fireEvent.press(card.getByTestId(`${form}-send`));
    await settle();
    expect(calls.map((call) => call.path)).toEqual(["/api/qa/pending/:id/answer"]);
    expect(card.getByTestId(`${form}-q1-b`).props.disabled).toBe(true);
    expect(card.getByTestId(`${form}-q1-text`).props.editable).toBe(false);

    await act(async () => {
        release();
        await Bun.sleep(5);
    });
    expect(card.getByTestId(`${form}-q1-b`).props.disabled).toBe(false);
    expect(card.getByTestId(`${form}-q1-text`).props.editable).toBe(true);
});
