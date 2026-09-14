import { Feather } from "@expo/vector-icons";
import { Pressable, Text, View } from "react-native";
import type { SavedCommand } from "@/features/quick-commands/types";
import { Card } from "@/ui/Card";
import { Empty } from "@/ui/Empty";
import { useThemeColors } from "@/theme/colors";

interface CommandGridProps {
    commands: SavedCommand[];
    /** Tapping a card starts the run flow (opens the target picker). */
    onRun: (command: SavedCommand) => void;
    /** Edit affordance opens the edit sheet for that snippet. */
    onEdit: (command: SavedCommand) => void;
    /** The "+" affordance opens the edit sheet in create mode. */
    onAdd: () => void;
}

/**
 * A 2-up grid of snippet Cards. Each card is `command-card-<id>` (tap → run), with a small edit
 * affordance (`command-edit-<id>`). An "Add" card (`command-add`) trails the grid. Empty → the shared
 * `Empty` primitive with a hint pointing at the add button.
 */
export function CommandGrid({ commands, onRun, onEdit, onAdd }: CommandGridProps) {
    const c = useThemeColors();

    if (commands.length === 0) {
        return (
            <View className="gap-3">
                <Empty
                    testID="commands-empty"
                    title="No saved commands"
                    hint="Tap Add to save your first one-tap snippet."
                />
                <Pressable
                    testID="command-add"
                    accessibilityLabel="command-add"
                    accessibilityRole="button"
                    onPress={onAdd}
                >
                    <Card className="flex-row items-center justify-center gap-2 py-4">
                        <Feather name="plus" size={16} color={c.accent} />
                        <Text style={{ color: c.accent, fontFamily: "monospace" }}>Add command</Text>
                    </Card>
                </Pressable>
            </View>
        );
    }

    return (
        <View className="flex-row flex-wrap gap-3">
            {commands.map((command) => (
                <Card
                    key={command.id}
                    testID={`command-card-${command.id}`}
                    style={{ flexBasis: "47%" }}
                    className="gap-2"
                >
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`command-run-${command.id}`}
                        testID={`command-run-${command.id}`}
                        onPress={() => onRun(command)}
                        className="gap-1"
                    >
                        <Text numberOfLines={1} style={{ color: c.textPrimary, fontFamily: "monospace" }}>
                            {command.label}
                        </Text>
                        <Text
                            numberOfLines={1}
                            className="text-xs"
                            style={{ color: c.textMuted, fontFamily: "monospace" }}
                        >
                            {command.command}
                        </Text>
                    </Pressable>
                    <Pressable
                        testID={`command-edit-${command.id}`}
                        accessibilityLabel={`command-edit-${command.id}`}
                        accessibilityRole="button"
                        onPress={() => onEdit(command)}
                        className="flex-row items-center gap-1 self-start"
                    >
                        <Feather name="edit-2" size={12} color={c.textMuted} />
                        <Text className="text-xs" style={{ color: c.textMuted, fontFamily: "monospace" }}>
                            Edit
                        </Text>
                    </Pressable>
                </Card>
            ))}

            <Pressable
                testID="command-add"
                accessibilityLabel="command-add"
                accessibilityRole="button"
                onPress={onAdd}
                style={{ flexBasis: "47%" }}
            >
                <Card className="flex-row items-center justify-center gap-2 py-6">
                    <Feather name="plus" size={16} color={c.accent} />
                    <Text style={{ color: c.accent, fontFamily: "monospace" }}>Add</Text>
                </Card>
            </Pressable>
        </View>
    );
}
