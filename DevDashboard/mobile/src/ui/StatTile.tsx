import { Text } from "react-native";
import { Card } from "@/ui/Card";
import { useThemeColors } from "@/theme/colors";

interface StatTileProps {
    label: string;
    value: string;
    sub?: string;
    testID: string;
    /** Two-up grid by default (RN flex-wrap needs a percentage basis). Set false for full-width. */
    half?: boolean;
}

/**
 * Shared labelled stat tile — mono uppercase label, big mono value, optional sub. Tier-1 primitive
 * (the generic form of Pulse's KPI cards; reuse for any "label + big number + sub" stat). Two sit
 * per row via `flexBasis: "48%"` (RN/Yoga collapses `flex-1`+wrap to one-per-row). Emits `testID`
 * + a `<testID>-value` for the value text so Appium can read it.
 */
export function StatTile({ label, value, sub, testID, half = true }: StatTileProps) {
    const c = useThemeColors();

    return (
        <Card testID={testID} className="gap-1" style={half ? { flexBasis: "48%", flexGrow: 1 } : undefined}>
            <Text
                accessibilityLabel={`${label} label`}
                className="text-xs uppercase tracking-widest"
                style={{ color: c.textMuted, fontFamily: "monospace" }}
            >
                {label}
            </Text>
            <Text
                testID={`${testID}-value`}
                className="text-2xl font-bold"
                style={{ color: c.textPrimary, fontFamily: "monospace" }}
            >
                {value}
            </Text>
            {sub ? (
                <Text className="text-xs" style={{ color: c.textSecondary, fontFamily: "monospace" }}>
                    {sub}
                </Text>
            ) : null}
        </Card>
    );
}
