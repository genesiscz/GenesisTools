import { Pressable, Text, View } from "react-native";
import { useThemeColors } from "@/theme/colors";

export interface UsageRange {
    label: string;
    minutes: number;
}

export const USAGE_RANGES: UsageRange[] = [
    { label: "1h", minutes: 60 },
    { label: "24h", minutes: 1440 },
    { label: "7d", minutes: 10080 },
];

interface RangeSelectorProps {
    value: number;
    onChange: (minutes: number) => void;
}

/**
 * Segmented range control for the usage-history charts (feature-local Tier-2). The active segment
 * gets the tinted accent surface. testID `claude-range-selector`; each segment is
 * `claude-range-<label>` (Appium taps these).
 */
export function RangeSelector({ value, onChange }: RangeSelectorProps) {
    const c = useThemeColors();

    return (
        <View testID="claude-range-selector" className="flex-row justify-end gap-2">
            {USAGE_RANGES.map((range) => {
                const active = range.minutes === value;
                return (
                    <Pressable
                        key={range.minutes}
                        testID={`claude-range-${range.label}`}
                        accessibilityRole="button"
                        onPress={() => onChange(range.minutes)}
                        className="rounded-full px-3 py-1"
                        style={{
                            backgroundColor: active ? c.accentMuted : "transparent",
                            borderWidth: 1,
                            borderColor: active ? c.accent : c.border,
                        }}
                    >
                        <Text
                            className="text-xs font-bold uppercase tracking-widest"
                            style={{ color: active ? c.accent : c.textMuted, fontFamily: "monospace" }}
                        >
                            {range.label}
                        </Text>
                    </Pressable>
                );
            })}
        </View>
    );
}
