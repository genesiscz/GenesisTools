import { afterEach, expect, it, mock } from "bun:test";
import type { ApprovalAnswerInput, ApprovalReceiptDto, PendingApprovalsDto } from "@dd/contract";
import { createElement } from "react";
mock.module("react-native", () => ({
    View: "View", Text: "Text", TextInput: "TextInput", Pressable: "View", ScrollView: "View",
    ActivityIndicator: "View", RefreshControl: "View", StyleSheet: { flatten: (value: unknown) => value ?? {} },
}));
mock.module("expo-router", () => ({ Stack: { Screen: () => null } }));
let pendingData: PendingApprovalsDto = { pending: [] };
// The Mac answers at once and the refetch that follows is the test's rerender with a new pending list.
mock.module("@/features/approvals/hooks", () => ({
    useAnswerApproval: (onReceipt: (receipt: ApprovalReceiptDto) => void) => ({
        isPending: false,
        isError: false,
        mutate: (input: ApprovalAnswerInput) =>
            onReceipt({ id: input.id, verdict: input.verdict, outcome: "sent", route: "pane", detail: "key sent" }),
    }),
    usePendingApprovals: () => ({ isPending: false, isError: false, isRefetching: false, data: pendingData, refetch: async () => undefined }),
}));
mock.module("@/lib/face-id", () => ({ confirmWithFaceId: async () => ({ ok: false }) }));
mock.module("@/theme/colors", () => ({ useThemeColors: () => ({ bgBase: "black", textPrimary: "white", textMuted: "gray" }) }));
mock.module("@/ui/Empty", () => ({ Empty: () => null }));
mock.module("@/ui/MockBadge", () => ({ MockBadge: () => null }));
mock.module("@/ui/StatusPill", () => ({ StatusPill: () => null }));
const { cleanup, render, fireEvent } = await import("@testing-library/react-native/pure");
const { MOCK_APPROVALS } = await import("@/api/fixtures/approvals");
const { default: ApprovalsScreen, Mono } = await import("@/app/(more)/approvals");
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
it("keeps a deny's receipt after the answered request leaves the pending list", async () => {
    const [bash] = MOCK_APPROVALS.pending;
    pendingData = { pending: [bash] };
    const screen = await render(createElement(ApprovalsScreen));
    await fireEvent.press(screen.getByLabelText("Deny Bash"));
    expect(screen.getByTestId(`approval-receipt-${bash.id}`).props.children).toBe("Sent: key sent");

    pendingData = { pending: [] };
    await screen.rerender(createElement(ApprovalsScreen));
    expect(screen.queryByTestId(`approval-${bash.id}`)).toBeNull();
    expect(screen.getByTestId(`approval-receipt-${bash.id}`).props.children).toBe("Bash: Sent: key sent");
});
it("names the deny reason field after the tool it denies", async () => {
    const [bash] = MOCK_APPROVALS.pending;
    pendingData = { pending: [bash] };
    const screen = await render(createElement(ApprovalsScreen));
    expect(screen.getByLabelText("Reason for denying Bash").props.testID).toBe(`approval-reason-${bash.id}`);
});
