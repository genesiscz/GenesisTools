import { afterEach, expect, it, mock } from "bun:test";
import { createElement, type ReactNode, useEffect } from "react";

interface Pressable {
    testID?: string;
    onPress?: () => void;
}

const host = ({ children }: { children?: ReactNode }) => createElement("View", null, children);
const button = ({ testID, onPress }: Pressable) => createElement("View", { testID, onPress });

// Bun cannot parse React Native's Flow entry point; retain props and children on host nodes.
mock.module("react-native", () => ({
    View: "View",
    Text: "Text",
    Pressable: "View",
    Alert: { alert: () => undefined },
    StyleSheet: { flatten: (style: unknown) => style ?? {} },
}));
mock.module("expo-router", () => ({
    router: { push: () => undefined },
    useFocusEffect: (effect: () => void) => useEffect(effect, [effect]),
}));
mock.module("@/theme/colors", () => ({ useThemeColors: () => ({}) }));
mock.module("@/transport/reachability", () => ({ FAILURE_MESSAGE: {} }));
mock.module("@/ui/Card", () => ({ Card: host }));
mock.module("@/ui/Empty", () => ({ Empty: host }));
mock.module("@/ui/Loading", () => ({ Loading: host }));
mock.module("@/ui/Screen", () => ({ Screen: host }));
mock.module("@/ui/SectionHeader", () => ({ SectionHeader: host }));
mock.module("@/features/connections/ConnectionRow", () => ({ ConnectionRow: host }));
mock.module("@/features/connections/components", () => ({
    Eyebrow: host,
    MeshOrbs: host,
    GhostButton: button,
    PrimaryButton: button,
}));
mock.module("@/features/connections/ConnectionForm", () => ({
    ConnectionForm: ({ onSubmit }: { onSubmit: (values: object) => void }) =>
        button({
            testID: "form-submit",
            onPress: () => onSubmit({ label: "", host: "machine-b.test", username: "alice", password: "secret" }),
        }),
}));

const saved: string[] = [];
const connects: { host: string }[] = [];
const refused = { ok: false, failure: "error", error: "machine-b.test did not answer" };
const state = {
    connections: [],
    activeId: null,
    listConnections: async () => [],
    connect: async (input: { host: string }) => {
        connects.push(input);
        return refused;
    },
    addConnection: async (input: { host: string }) => {
        saved.push(input.host);
        return "row-b";
    },
    activate: async () => refused,
    updateConnection: async () => undefined,
    remove: async () => undefined,
};
mock.module("@/state/connection-store", () => ({
    useConnectionStore: (select: (value: typeof state) => unknown) => select(state),
}));

const { cleanup, fireEvent, render } = await import("@testing-library/react-native/pure");
const { ConnectionsScreen } = await import("@/features/connections/ConnectionsScreen");

afterEach(cleanup);

it("an added Mac that does not answer its probe is not saved, and the form shows why", async () => {
    const screen = await render(createElement(ConnectionsScreen));
    await fireEvent.press(screen.getByTestId("btn-add-connection"));
    await fireEvent.press(screen.getByTestId("form-submit"));

    expect(saved).toEqual([]);
    expect(connects).toMatchObject([{ tier: "lan", host: "machine-b.test", port: 3042, username: "alice" }]);
    expect(screen.getByLabelText("connections-error").props.children).toBe("machine-b.test did not answer");
});
