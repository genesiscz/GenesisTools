import { afterEach, expect, it, mock } from "bun:test";
import { createElement } from "react";
mock.module("react-native", () => ({
    View: "View", Text: "Text", TextInput: "TextInput", Pressable: "View", ScrollView: "View",
    ActivityIndicator: "View", RefreshControl: "View", StyleSheet: { flatten: (value: unknown) => value ?? {} },
}));
mock.module("expo-router", () => ({ Stack: () => null }));
mock.module("@/features/approvals/hooks", () => ({ useAnswerApproval: () => ({}), usePendingApprovals: () => ({}) }));
mock.module("@/lib/face-id", () => ({ confirmWithFaceId: async () => ({ ok: false }) }));
mock.module("@/theme/colors", () => ({ useThemeColors: () => ({ bgBase: "black", textPrimary: "white", textMuted: "gray" }) }));
mock.module("@/ui/Empty", () => ({ Empty: () => null }));
mock.module("@/ui/MockBadge", () => ({ MockBadge: () => null }));
mock.module("@/ui/StatusPill", () => ({ StatusPill: () => null }));
const { cleanup, render, fireEvent } = await import("@testing-library/react-native/pure");
const { Mono } = await import("@/app/(more)/approvals");
afterEach(cleanup);
it("allows inspection of the entire operation beyond line 24 before approval", async () => {
    const text = Array.from({ length: 30 }, (_, i) => `operation ${i + 1}`).join("\n");
    const card = await render(createElement(Mono, { text, testID: "details" }));
    expect(card.getByTestId("details").props.children).not.toContain("operation 30");
    await fireEvent.press(card.getByLabelText("Show full approval details"));
    expect(card.getByTestId("details").props.children).toBe(text);
    await fireEvent.press(card.getByLabelText("Show fewer lines"));
    expect(card.getByTestId("details").props.children).not.toContain("operation 30");
});
