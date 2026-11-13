import { afterEach, expect, it, mock } from "bun:test";
import type { AgentBoardChild, AgentBoardSession } from "@dd/contract";
import { createElement } from "react";

mock.module("react-native", () => ({
    View: "View",
    Text: "Text",
    Pressable: "View",
    StyleSheet: { flatten: (style: unknown) => style ?? {} },
}));
mock.module("@/features/agents/components/PhaseBadge", () => ({ PhaseBadge: () => null }));
mock.module("@/theme/colors", () => ({ useThemeColors: () => ({}) }));

const { cleanup, fireEvent, render } = await import("@testing-library/react-native/pure");
const { SessionCard, sessionAccessibilityLabel } = await import("./SessionCard");
afterEach(cleanup);

const child = (id: string) => ({ id, name: `worker ${id}`, status: "running", liveLabel: null, children: [] }) as unknown as AgentBoardChild;
const session = {
    key: "claude:one",
    provider: "claude",
    project: "demo",
    label: "working",
    title: "Fix the login page",
    lastPrompt: "make the button blue",
    account: "work",
    model: null,
    stalled: false,
    stuck: null,
    lastActivityAt: null,
    children: ["a", "b", "c", "d", "e", "f"].map(child),
} as unknown as AgentBoardSession;

it("lists four sub-agents and reveals the rest in place", async () => {
    const view = await render(createElement(SessionCard, { session, now: 0, onOpen: () => {} }));
    expect(view.queryAllByTestId(/^agent-child-/)).toHaveLength(4);
    await fireEvent.press(view.getByTestId("agent-children-more-claude:one"));
    expect(view.queryAllByTestId(/^agent-child-/)).toHaveLength(6);
    expect(view.queryByTestId("agent-children-more-claude:one")).toBeNull();
});

it("names the card by its title and account, so two sessions in one project and phase differ", () => {
    expect(sessionAccessibilityLabel(session)).toBe("demo, working, Fix the login page, work");
    expect(sessionAccessibilityLabel({ ...session, title: null })).toBe("demo, working, make the button blue, work");
});
