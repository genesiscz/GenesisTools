import { afterEach, beforeEach, expect, it, mock } from "bun:test";
import type { AgentBoardSession, AgentTranscriptTurnDto } from "@dd/contract";
import { createElement, Fragment, type ReactElement } from "react";

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
mock.module("@/features/agents/hooks", () => ({
    useAgentsBoard: () => board,
    useBoardSession: (key: string) => board.data?.sessions.find((entry) => entry.key === key),
    useAgentTranscript: () => ({ isPending: false, isError: false, data: { turns, truncated: false } }),
    useStopSession: () => ({ isPending: false, isError: false, mutate: () => undefined }),
}));
mock.module("@/features/agents/components/PhaseBadge", () => ({ PhaseBadge: () => null }));
mock.module("@/features/agents/components/PingButton", () => ({ PingButton: () => null }));
mock.module("@/features/agents/components/SessionCard", () => ({ ago: () => "1 min" }));
mock.module("@/features/agents/components/SteerComposer", () => ({ SteerComposer: () => null }));
mock.module("@/features/answer-queue/units", () => ({ idempotencyKey: () => "key" }));
mock.module("@/lib/face-id", () => ({ confirmWithFaceId: async () => ({ ok: true }) }));
mock.module("@/ui/Empty", () => ({
    Empty: ({ testID, title }: { testID?: string; title: string }) => createElement("Text", { testID }, title),
}));
mock.module("@/theme/colors", () => ({ useThemeColors: () => ({}) }));

const { cleanup, render } = await import("@testing-library/react-native/pure");
const { MOCK_BOARD } = await import("@/api/fixtures/agents");
const { default: AgentSessionScreen } = await import("@/app/(more)/agent-session");

function session(key: string): AgentBoardSession {
    return { ...MOCK_BOARD.sessions[0], key, sessionId: `id-${key}`, stuck: null, children: [] };
}

beforeEach(() => {
    params = { key: "claude:a" };
    turns = [];
    board = { isPending: true, isError: false, error: null };
});
afterEach(cleanup);

it("waits for the board before it calls a session gone", async () => {
    const screen = await render(createElement(AgentSessionScreen));
    expect(screen.queryByTestId("session-gone")).toBeNull();
    expect(screen.getByTestId("session-loading")).toBeTruthy();

    board = { isPending: false, isError: false, error: null, data: { sessions: [session("claude:b")] } };
    await screen.rerender(createElement(AgentSessionScreen));
    expect(screen.getByTestId("session-gone")).toBeTruthy();
});
