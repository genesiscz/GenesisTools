import { Text, View } from "react-native";
import type { QaLiveStatus } from "@/features/qa/subscription";
import { useThemeColors } from "@/theme/colors";

interface QaLiveDotProps {
    status: QaLiveStatus;
    testID?: string;
}

/**
 * Live SSE indicator: an emerald dot + label when connected, muted while "connecting". A stream is
 * connected once it is OPEN ("open") or actively delivering rows ("live") — it no longer waits for
 * the first streamed row, so an idle-but-connected agent reads "live" instead of "connecting"
 * forever. Exposes the raw status as the element's accessibility VALUE (`accessibilityValue.text`)
 * so an Appium spec can `waitForValue("qa-live-indicator", "open" | "live")`. Mirrors the web QA
 * top-bar live dot.
 */
export function QaLiveDot({ status, testID = "qa-live-indicator" }: QaLiveDotProps) {
    const c = useThemeColors();
    const connected = status === "open" || status === "live";
    const color = connected ? c.accent : c.textMuted;

    return (
        <View
            testID={testID}
            accessibilityLabel={testID}
            accessibilityValue={{ text: status }}
            className="flex-row items-center gap-1.5"
        >
            <View className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
            <Text className="text-[10px] font-bold uppercase tracking-widest" style={{ color, fontFamily: "monospace" }}>
                {connected ? "live" : "connecting"}
            </Text>
        </View>
    );
}
