import { afterEach, expect, it, mock } from "bun:test";
import { createElement, type ReactNode } from "react";

mock.module("react-native", () => ({
    View: "View",
    Text: "Text",
    Pressable: "Pressable",
    Alert: { alert: () => undefined, prompt: () => undefined },
    StyleSheet: { flatten: (value: unknown) => value ?? {} },
}));

interface Query {
    isPending: boolean;
    isError: boolean;
    data?: { sessions: Array<{ name: string; windows: number; attached: number }> };
}

let tmux: Query = { isPending: true, isError: false };
const idle = { mutate: () => undefined, isPending: false };
mock.module("@/features/terminals/hooks", () => ({
    useTmuxSessions: () => tmux,
    useTtydSessions: () => ({ isPending: false, isError: false, data: { sessions: [] } }),
    useCmuxSnapshot: () => ({ isPending: false, isError: false, data: undefined }),
    useSpawnTtyd: () => idle,
    useKillTtyd: () => idle,
    useRenameTtyd: () => idle,
    useRenameTmux: () => idle,
    useCreateTmux: () => idle,
    useCmuxAttach: () => idle,
}));
mock.module("@/features/terminals/components/SwipeableActionRow", () => ({
    SwipeableActionRow: ({ children }: { children: ReactNode }) => children,
}));
mock.module("@/ui/Card", () => ({ Card: ({ children }: { children: ReactNode }) => createElement("View", null, children) }));
mock.module("@/ui/Empty", () => ({
    Empty: ({ testID, title }: { testID?: string; title: string }) => createElement("Text", { testID }, title),
}));
mock.module("@/ui/SectionHeader", () => ({ SectionHeader: () => null }));
mock.module("@/ui/StatusPill", () => ({ StatusPill: () => null }));
mock.module("@/theme/colors", () => ({ useThemeColors: () => ({}) }));

const { cleanup, render } = await import("@testing-library/react-native/pure");
const { SessionsList } = await import("@/features/terminals/components/SessionsList");

afterEach(cleanup);

it("says the tmux list is being read until the Mac answers, and only then that it is empty", async () => {
    tmux = { isPending: true, isError: false };
    const screen = await render(createElement(SessionsList, { onOpen: () => undefined }));
    expect(screen.getByTestId("terminals-tmux-loading")).toBeTruthy();
    expect(screen.queryByTestId("terminals-tmux-empty")).toBeNull();

    tmux = { isPending: false, isError: false, data: { sessions: [] } };
    await screen.rerender(createElement(SessionsList, { onOpen: () => undefined }));
    expect(screen.queryByTestId("terminals-tmux-loading")).toBeNull();
    expect(screen.getByTestId("terminals-tmux-empty").props.children).toBe("No tmux sessions");
});

it("names a failed tmux read in its empty state", async () => {
    tmux = { isPending: false, isError: true };
    const screen = await render(createElement(SessionsList, { onOpen: () => undefined }));
    expect(screen.getByTestId("terminals-tmux-empty").props.children).toBe("tmux sessions unavailable");
});
