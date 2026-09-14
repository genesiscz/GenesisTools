import { Feather } from "@expo/vector-icons";
import { Pressable, Text, View } from "react-native";
import { Card } from "@/ui/Card";
import { KeyValueRow } from "@/ui/KeyValueRow";
import { StatusPill } from "@/ui/StatusPill";
import type { TmuxPresetSummary } from "@/features/tmux-presets/types";
import { formatBytes, formatCapturedAt, summaryLine } from "@/features/tmux-presets/units";
import { useThemeColors } from "@/theme/colors";

interface Props {
    preset: TmuxPresetSummary;
    onRestore: (name: string) => void;
    onDelete: (name: string) => void;
}

/**
 * One saved preset = a double-bezel `<Card>`: name + a pane-count `StatusPill`, three `KeyValueRow`s
 * (layout / captured / size), an optional note, and a Restore/Delete action row. The action buttons
 * are feature-local inline `Pressable`s (no shared Button primitive; the terminals + more screens use
 * the same inline pattern). Tapping an action does NOT mutate — it opens the shared confirm dialog.
 */
export function PresetCard({ preset, onRestore, onDelete }: Props) {
    const c = useThemeColors();

    return (
        <Card
            bezel
            testID={`tmux-presets-row-${preset.name}`}
            className="gap-2"
        >
            <View className="flex-row items-center justify-between gap-2">
                <Text
                    numberOfLines={1}
                    className="flex-1 text-base font-bold"
                    style={{ color: c.textPrimary, fontFamily: "monospace" }}
                >
                    {preset.name}
                </Text>
                <StatusPill label={`${preset.panes} panes`} tone="accent" dot normalCase />
            </View>

            <KeyValueRow
                testID={`tmux-presets-summary-${preset.name}`}
                label="Layout"
                value={summaryLine(preset)}
            />
            <KeyValueRow label="Captured" value={formatCapturedAt(preset.capturedAt)} />
            <KeyValueRow label="Size" value={formatBytes(preset.bytes)} />

            {preset.note ? (
                <Text numberOfLines={2} className="text-xs" style={{ color: c.textMuted, fontFamily: "monospace" }}>
                    {preset.note}
                </Text>
            ) : null}

            <View className="mt-1 flex-row gap-2">
                <Pressable
                    testID={`tmux-presets-restore-${preset.name}`}
                    accessibilityRole="button"
                    accessibilityLabel={`restore ${preset.name}`}
                    onPress={() => onRestore(preset.name)}
                    className="flex-1 flex-row items-center justify-center gap-2 rounded-lg px-3 py-2"
                    style={{ backgroundColor: c.accentMuted, borderWidth: 1, borderColor: c.border }}
                >
                    <Feather name="refresh-cw" size={14} color={c.accent} />
                    <Text className="font-bold" style={{ color: c.accent, fontFamily: "monospace" }}>
                        Restore
                    </Text>
                </Pressable>
                <Pressable
                    testID={`tmux-presets-delete-${preset.name}`}
                    accessibilityRole="button"
                    accessibilityLabel={`delete ${preset.name}`}
                    onPress={() => onDelete(preset.name)}
                    className="flex-row items-center justify-center gap-2 rounded-lg px-3 py-2"
                    style={{ borderWidth: 1, borderColor: c.border }}
                >
                    <Feather name="trash-2" size={14} color={c.danger} />
                    <Text className="font-bold" style={{ color: c.danger, fontFamily: "monospace" }}>
                        Delete
                    </Text>
                </Pressable>
            </View>
        </Card>
    );
}
