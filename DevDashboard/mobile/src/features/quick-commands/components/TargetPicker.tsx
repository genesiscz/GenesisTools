import { Modal, Pressable, Text, View } from "react-native";
import type { RunTargetOption, SavedCommand } from "@/features/quick-commands/types";
import { useTmuxSessions } from "@/features/terminals/hooks";
import { Card } from "@/ui/Card";
import { ListRow } from "@/ui/ListRow";
import { SectionHeader } from "@/ui/SectionHeader";
import { useThemeColors } from "@/theme/colors";

interface TargetPickerProps {
    /** The snippet whose run target is being chosen; null = picker closed. */
    command: SavedCommand | null;
    onPick: (option: RunTargetOption) => void;
    onCancel: () => void;
}

/**
 * A modal that lists run targets for a snippet: the "Quick" default (DevDashboard workspace) first,
 * then every live tmux session that already has a cmux surface (so the snippet can be beamed into an
 * existing workspace's surface). Each row is `target-pick-<id>` (id = "quick" or the tmux session
 * name). Picking calls `onPick` with the resolved `DashboardSendTarget`; the screen then shows the
 * run-confirm.
 */
export function TargetPicker({ command, onPick, onCancel }: TargetPickerProps) {
    const c = useThemeColors();
    const sessions = useTmuxSessions();

    const options: RunTargetOption[] = [
        { id: "quick", label: "Quick — DevDashboard workspace", target: { mode: "quick_dev_dashboard" } },
        ...(sessions.data?.sessions ?? [])
            .filter((s) => s.cmuxSurfaces.length > 0)
            .map((s) => ({
                id: s.name,
                label: `Existing surface — ${s.name}`,
                target: {
                    mode: "existing_surface" as const,
                    workspaceId: s.cmuxSurfaces[0]!.workspaceId,
                    surfaceId: s.cmuxSurfaces[0]!.surfaceId,
                },
            })),
    ];

    return (
        <Modal visible={command !== null} transparent animationType="slide" onRequestClose={onCancel}>
            <View
                testID="target-picker"
                accessibilityLabel="target-picker"
                className="flex-1 justify-end bg-black/60"
            >
                <View className="gap-3 rounded-t-3xl bg-dd-bg-base p-4">
                    <SectionHeader title={command ? `Run "${command.label}" in…` : "Run in…"} />
                    <Card className="gap-1">
                        {options.map((option) => (
                            <ListRow
                                key={option.id}
                                testID={`target-pick-${option.id}`}
                                primary={option.label}
                                onPress={() => onPick(option)}
                            />
                        ))}
                    </Card>
                    <Pressable
                        testID="target-cancel"
                        accessibilityLabel="target-cancel"
                        accessibilityRole="button"
                        onPress={onCancel}
                        className="items-center py-3"
                    >
                        <Text style={{ color: c.textMuted, fontFamily: "monospace" }}>Cancel</Text>
                    </Pressable>
                </View>
            </View>
        </Modal>
    );
}
