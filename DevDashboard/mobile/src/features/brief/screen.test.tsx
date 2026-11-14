import { afterEach, expect, it, mock } from "bun:test";
import { createElement } from "react";

mock.module("react-native", () => ({
    View: "View",
    Text: "Text",
    Pressable: "Pressable",
    ScrollView: "View",
    RefreshControl: "View",
    ActivityIndicator: "View",
    StyleSheet: { flatten: (value: unknown) => value ?? {} },
}));
mock.module("expo-router", () => ({ router: { push: () => undefined }, Stack: { Screen: () => null } }));
mock.module("@expo/vector-icons", () => ({ Feather: () => null }));
mock.module("@/features/brief/hooks", () => ({
    useMorningBrief: () => ({ data: MOCK_BRIEF, isPending: false, isError: false, isRefetching: false, refetch: async () => undefined }),
}));
mock.module("@/theme/colors", () => ({ useThemeColors: () => ({}) }));
mock.module("@/ui/Empty", () => ({ Empty: () => null }));
mock.module("@/ui/MockBadge", () => ({ MockBadge: () => null }));
mock.module("@/ui/StatusPill", () => ({ StatusPill: () => null }));

const { MOCK_BRIEF } = await import("@/api/fixtures/brief");
const { cleanup, render } = await import("@testing-library/react-native/pure");
const { default: BriefScreen } = await import("@/app/(more)/brief");

afterEach(cleanup);

it("reads each tappable line's numbers and summary in its accessible name, not only its title", async () => {
    const screen = await render(createElement(BriefScreen));

    expect(screen.getByTestId("brief-decisions").props.accessibilityLabel).toBe("Decisions: 4 waiting");
    expect(screen.getByTestId("brief-weather").props.accessibilityLabel).toBe("Weather · Home: 6 °C, Fog");
    expect(screen.getByTestId("brief-overnight").props.accessibilityLabel).toContain("Port the parser");
    expect(screen.getByTestId("brief-resets").props.accessibilityLabel).toContain("work 5h");
});
