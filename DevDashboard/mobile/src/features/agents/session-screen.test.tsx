import { afterEach, beforeEach, expect, it, mock } from "bun:test";
import type { AgentBoardSession, AgentStopReceiptDto, AgentTranscriptTurnDto } from "@dd/contract";
import { createElement, Fragment, type ReactElement, useState } from "react";

interface FlatListProps {
    data: AgentTranscriptTurnDto[];
    renderItem: (info: { item: AgentTranscriptTurnDto; index: number }) => ReactElement;
    keyExtractor: (item: AgentTranscriptTurnDto, index: number) => string;
    ListHeaderComponent?: ReactElement | null;
    testID?: string;
}

mock.module("react-native", () => ({
    View: "View",
    Text: "Text",
    TextInput: "TextInput",
    Pressable: "Pressable",
    ActivityIndicator: "ActivityIndicator",
    KeyboardAvoidingView: "View",
    Platform: { OS: "ios" },
    Alert: { alert: () => undefined },
    StyleSheet: { flatten: (value: unknown) => value ?? {} },
    FlatList: ({ data, renderItem, keyExtractor, ListHeaderComponent, testID }: FlatListProps) =>
        createElement(
            "FlatList",
            { testID },
            ListHeaderComponent ?? null,
            data.map((item, index) => createElement(Fragment, { key: keyExtractor(item, index) }, renderItem({ item, index })))
        ),
}));

let params: { key?: string; text?: string } = { key: "claude:a" };
mock.module("expo-router", () => ({ Stack: { Screen: () => null }, useLocalSearchParams: () => params }));

interface BoardState {
    data?: { sessions: AgentBoardSession[]; sendTimings?: undefined };
    isPending: boolean;
    isError: boolean;
    error: unknown;
}

let board: BoardState = { isPending: true, isError: false, error: null };
let turns: AgentTranscriptTurnDto[] = [];
let answerStop: ((receipt: AgentStopReceiptDto) => void) | null = null;
mock.module("@/features/agents/hooks", () => ({
    useAgentsBoard: () => board,
    useBoardSession: (key: string) => board.data?.sessions.find((entry) => entry.key === key),
    useAgentTranscript: () => ({ isPending: false, isError: false, data: { turns, truncated: false } }),
    useStopSession: (onReceipt: (receipt: AgentStopReceiptDto) => void) => {
        answerStop = onReceipt;
        return { isPending: false, isError: false, mutate: () => undefined };
    },
}));
mock.module("@/features/agents/components/PhaseBadge", () => ({ PhaseBadge: () => null }));
mock.module("@/features/agents/components/PingButton", () => ({ PingButton: () => null }));
mock.module("@/features/agents/components/SessionCard", () => ({ ago: () => "1 min" }));
// Remembers the session it first mounted for, as the real composer's unsent text does.
mock.module("@/features/agents/components/SteerComposer", () => ({
    SteerComposer: ({ session: mountedFor }: { session: AgentBoardSession }) => {
        const [first] = useState(mountedFor.key);
        return createElement("Text", { testID: "composer" }, first);
    },
}));
mock.module("@/features/answer-queue/units", () => ({ idempotencyKey: () => "key" }));
mock.module("@/lib/face-id", () => ({ confirmWithFaceId: async () => ({ ok: true }) }));
mock.module("@/ui/Empty", () => ({
    Empty: ({ testID, title }: { testID?: string; title: string }) => createElement("Text", { testID }, title),
}));
mock.module("@/theme/colors", () => ({ useThemeColors: () => ({}) }));

const { act, cleanup, fireEvent, render } = await import("@testing-library/react-native/pure");
const { MOCK_BOARD } = await import("@/api/fixtures/agents");
const { default: AgentSessionScreen } = await import("@/app/(more)/agent-session");

function session(key: string): AgentBoardSession {
    return { ...MOCK_BOARD.sessions[0], key, sessionId: `id-${key}`, stuck: null, children: [] };
}

function live(...keys: string[]): BoardState {
    return { isPending: false, isError: false, error: null, data: { sessions: keys.map(session) } };
}

beforeEach(() => {
    params = { key: "claude:a" };
    turns = [];
    board = { isPending: true, isError: false, error: null };
    answerStop = null;
});
afterEach(cleanup);

it("keeps a stop's receipt after the stopped session leaves the board", async () => {
    board = live("claude:a");
    const screen = await render(createElement(AgentSessionScreen));
    await act(async () => answerStop?.({ key: "claude:a", pid: 42, stopped: true, signal: "TERM", survivors: [], reason: null }));

    board = live();
    await screen.rerender(createElement(AgentSessionScreen));
    expect(screen.getByTestId("session-gone")).toBeTruthy();
    expect(screen.getByTestId("stop-receipt").props.children).toBe("Stopped (TERM).");
});

it("gives the next session of the same route a fresh composer and no stop receipt", async () => {
    board = live("claude:a", "claude:b");
    const screen = await render(createElement(AgentSessionScreen));
    await act(async () => answerStop?.({ key: "claude:a", pid: 42, stopped: true, signal: "TERM", survivors: [], reason: null }));
    expect(screen.getByTestId("composer").props.children).toBe("claude:a");

    params = { key: "claude:b" };
    await screen.rerender(createElement(AgentSessionScreen));
    expect(screen.getByTestId("composer").props.children).toBe("claude:b");
    expect(screen.queryByTestId("stop-receipt")).toBeNull();
});

it("shows the whole of a long turn on request, and cuts it again", async () => {
    const long = `${"a".repeat(1_600)} the question at the end`;
    turns = [{ id: "t1", role: "assistant", at: null, text: long, tools: [] }];
    board = live("claude:a");
    const screen = await render(createElement(AgentSessionScreen));
    expect(screen.getByTestId("turn-text-t1").props.children).not.toContain("the question at the end");

    await fireEvent.press(screen.getByLabelText("Show all of this turn"));
    expect(screen.getByTestId("turn-text-t1").props.children).toBe(long);

    await fireEvent.press(screen.getByLabelText("Show less of this turn"));
    expect(screen.getByTestId("turn-text-t1").props.children).not.toContain("the question at the end");
});

it("shows a tool call's output, a failed one's error too, when the call is tapped", async () => {
    turns = [
        {
            id: "t2",
            role: "assistant",
            at: null,
            text: "",
            tools: [{ id: "call-1", name: "Bash", inputPreview: "bun test", result: "exit 1: 3 tests failed", isError: true }],
        },
    ];
    board = live("claude:a");
    const screen = await render(createElement(AgentSessionScreen));
    expect(screen.queryByTestId("tool-result-call-1")).toBeNull();

    await fireEvent.press(screen.getByLabelText("Failed Bash call, show its output"));
    expect(screen.getByTestId("tool-result-call-1").props.children).toBe("exit 1: 3 tests failed");
});

it("waits for the board before it calls a session gone", async () => {
    const screen = await render(createElement(AgentSessionScreen));
    expect(screen.queryByTestId("session-gone")).toBeNull();
    expect(screen.getByTestId("session-loading")).toBeTruthy();

    board = { isPending: false, isError: false, error: null, data: { sessions: [session("claude:b")] } };
    await screen.rerender(createElement(AgentSessionScreen));
    expect(screen.getByTestId("session-gone")).toBeTruthy();
});
