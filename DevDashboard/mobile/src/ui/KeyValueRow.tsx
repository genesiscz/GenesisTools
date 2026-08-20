import { Text, View } from "react-native";
import { useThemeColors } from "@/theme/colors";

interface KeyValueRowProps {
    label: string;
    value: string;
    testID?: string;
}

/**
 * Shared left-label / right-value mono row (the "Wi-Fi … value" pattern). Tier-1 primitive — reuse
 * for any key/value list. Callers pass a pre-formatted `value` (e.g. an em-dash for missing data).
 */
export function KeyValueRow({ label, value, testID }: KeyValueRowProps) {
    const c = useThemeColors();

    return (
        <View testID={testID} accessibilityLabel={`${label}: ${value}`} className="flex-row items-center justify-between">
            <Text style={{ color: c.textMuted, fontFamily: "monospace" }}>{label}</Text>
            <Text style={{ color: c.textPrimary, fontFamily: "monospace" }}>{value}</Text>
        </View>
    );
}
