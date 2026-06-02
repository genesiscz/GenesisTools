import { useEffect, useState } from "react";
import { Modal, Pressable, Text, TextInput, View } from "react-native";
import type { SavedCommand } from "@/features/quick-commands/types";
import { Card } from "@/ui/Card";
import { SectionHeader } from "@/ui/SectionHeader";
import { useThemeColors } from "@/theme/colors";

interface EditCommandSheetProps {
    /** `null` = closed; `"new"` = create mode; a `SavedCommand` = edit mode (delete enabled). */
    editing: SavedCommand | "new" | null;
    onSave: (input: { label: string; command: string }) => void;
    onDelete: (id: string) => void;
    onCancel: () => void;
    saving?: boolean;
}

/**
 * The create/edit form for a snippet — label + command text inputs in a bottom sheet. `command-save`
 * is disabled until both fields are non-empty (mirrors the backend `validateCommandInput`).
 * `command-delete` only renders in edit mode. testIDs: `command-input-label`, `command-input-text`,
 * `command-save`, `command-delete`, `command-cancel`, `edit-command-sheet`.
 */
export function EditCommandSheet({ editing, onSave, onDelete, onCancel, saving = false }: EditCommandSheetProps) {
    const c = useThemeColors();
    const existing = editing && editing !== "new" ? editing : null;
    const [label, setLabel] = useState("");
    const [command, setCommand] = useState("");

    useEffect(() => {
        setLabel(existing?.label ?? "");
        setCommand(existing?.command ?? "");
    }, [existing]);

    const canSave = label.trim().length > 0 && command.trim().length > 0 && !saving;

    return (
        <Modal visible={editing !== null} transparent animationType="slide" onRequestClose={onCancel}>
            <View
                testID="edit-command-sheet"
                accessibilityLabel="edit-command-sheet"
                className="flex-1 justify-end bg-black/60"
            >
                <View className="gap-3 rounded-t-3xl bg-dd-bg-base p-4">
                    <SectionHeader title={existing ? "Edit command" : "New command"} />
                    <Card className="gap-3">
                        <TextInput
                            testID="command-input-label"
                            accessibilityLabel="command-input-label"
                            placeholder="Label (e.g. Run tests)"
                            placeholderTextColor={c.textMuted}
                            value={label}
                            onChangeText={setLabel}
                            autoCapitalize="none"
                            style={{ color: c.textPrimary, fontFamily: "monospace" }}
                            className="rounded-lg border border-dd-border bg-dd-bg-panel px-3 py-2"
                        />
                        <TextInput
                            testID="command-input-text"
                            accessibilityLabel="command-input-text"
                            placeholder="Command (e.g. bun test)"
                            placeholderTextColor={c.textMuted}
                            value={command}
                            onChangeText={setCommand}
                            autoCapitalize="none"
                            autoCorrect={false}
                            style={{ color: c.textPrimary, fontFamily: "monospace" }}
                            className="rounded-lg border border-dd-border bg-dd-bg-panel px-3 py-2"
                        />
                    </Card>

                    <Pressable
                        testID="command-save"
                        accessibilityLabel="command-save"
                        accessibilityRole="button"
                        disabled={!canSave}
                        onPress={() => onSave({ label: label.trim(), command: command.trim() })}
                        style={{ opacity: canSave ? 1 : 0.4 }}
                    >
                        <Card className="items-center py-3">
                            <Text style={{ color: c.accent, fontFamily: "monospace" }}>
                                {saving ? "Saving…" : "Save"}
                            </Text>
                        </Card>
                    </Pressable>

                    {existing ? (
                        <Pressable
                            testID="command-delete"
                            accessibilityLabel="command-delete"
                            accessibilityRole="button"
                            onPress={() => onDelete(existing.id)}
                            className="items-center py-2"
                        >
                            <Text style={{ color: c.danger, fontFamily: "monospace" }}>Delete</Text>
                        </Pressable>
                    ) : null}

                    <Pressable
                        testID="command-cancel"
                        accessibilityLabel="command-cancel"
                        accessibilityRole="button"
                        onPress={onCancel}
                        className="items-center py-2"
                    >
                        <Text style={{ color: c.textMuted, fontFamily: "monospace" }}>Cancel</Text>
                    </Pressable>
                </View>
            </View>
        </Modal>
    );
}
