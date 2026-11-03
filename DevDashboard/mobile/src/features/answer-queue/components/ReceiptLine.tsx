import { Text } from "react-native";
import { RECEIPT_LABEL, type Receipt } from "@/features/answer-queue/units";
import { useThemeColors } from "@/theme/colors";

/** What happened to a send: delivered, queued for the agent's next turn, or uncertain (check the session). */
export function ReceiptLine({ receipt, testID }: { receipt: Receipt; testID: string }) {
    const c = useThemeColors();
    const color = receipt.kind === "delivered" ? c.accent : receipt.kind === "queued" ? c.textSecondary : c.danger;

    return (
        <Text testID={testID} accessibilityLiveRegion="polite" className="text-xs" style={{ color, fontFamily: "monospace" }}>
            {RECEIPT_LABEL[receipt.kind]}
            {receipt.detail ? ` · ${receipt.detail}` : ""}
        </Text>
    );
}

/** A refused or failed write, in words: the Mac's own sentence when it sent one. */
export function WriteError({ error, testID }: { error: unknown; testID: string }) {
    const c = useThemeColors();
    const message = error instanceof Error ? error.message.replace(/^\S+ -> \d+: /, "") : "The write failed.";

    return (
        <Text testID={testID} accessibilityLiveRegion="polite" className="text-xs" style={{ color: c.danger }}>
            {message}
        </Text>
    );
}
