import { afterEach, expect, it, mock } from "bun:test";
import { createElement } from "react";

mock.module("react-native", () => ({
    View: "View",
    Text: "Text",
    TextInput: "TextInput",
    Pressable: "Pressable",
    ScrollView: "View",
    ActivityIndicator: "View",
    StyleSheet: { flatten: (value: unknown) => value ?? {} },
}));
mock.module("expo-router", () => ({ router: { back: () => undefined }, Stack: { Screen: () => null } }));
mock.module("@/features/launch/hooks", () => ({
    useLaunchOptions: () => ({ data: MOCK_LAUNCH, isPending: false, isError: false }),
    useStartAgent: () => ({ isPending: false, isError: false, mutate: () => undefined }),
}));
mock.module("@/theme/colors", () => ({ useThemeColors: () => ({}) }));
mock.module("@/ui/MockBadge", () => ({ MockBadge: () => null }));
mock.module("@/ui/SectionHeader", () => ({ SectionHeader: () => null }));

const { MOCK_LAUNCH } = await import("@/api/fixtures/launch");
const { cleanup, fireEvent, render } = await import("@testing-library/react-native/pure");
const { default: AgentNewScreen } = await import("@/app/(more)/agent-new");

afterEach(cleanup);

it("announces the picked account as the checked radio, and names both text fields", async () => {
    const screen = await render(createElement(AgentNewScreen));
    expect(screen.getByTestId("launch-account-work").props.accessibilityState).toEqual({ checked: true });

    await fireEvent.press(screen.getByTestId("launch-account-personal"));
    expect(screen.getByTestId("launch-account-personal").props.accessibilityState).toEqual({ checked: true });
    expect(screen.getByTestId("launch-account-work").props.accessibilityState).toEqual({ checked: false });

    expect(screen.getByLabelText("Filter repos").props.testID).toBe("launch-repo-filter");
    expect(screen.getByLabelText("First prompt").props.testID).toBe("launch-prompt");
});
