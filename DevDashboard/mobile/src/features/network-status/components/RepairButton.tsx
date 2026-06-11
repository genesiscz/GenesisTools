import { router } from "expo-router";
import { Pressable, Text } from "react-native";

/**
 * "Re-pair" CTA — opens the existing connect/scan flow (`/connect`), where the agent's pairing QR is
 * re-scanned. Styled as the design-system primary emerald pressable (matching connect.tsx's
 * PrimaryButton). No QR is rendered here — the app pairs by SCANNING, so re-pair == re-open scanner.
 */
export function RepairButton() {
    return (
        <Pressable
            testID="network-status-repair-button"
            accessibilityRole="button"
            accessibilityLabel="Re-pair"
            onPress={() => router.push("/connect")}
            className="rounded-2xl bg-dd-accent-from px-5 py-3.5 active:scale-[0.98]"
            style={{ borderCurve: "continuous" }}
        >
            <Text className="text-center text-[15px] font-bold text-dd-bg-base">Re-pair</Text>
        </Pressable>
    );
}
