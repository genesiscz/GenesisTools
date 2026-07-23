import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { Card } from "@/ui/Card";
import { useAddTodo } from "@/features/reminders-todos/hooks";
import { useThemeColors } from "@/theme/colors";

/**
 * Inline "add a reminder" form (feature-local). A title `TextInput` + submit `Pressable` over
 * `useAddTodo()`; on success the mutation invalidates the `["todos", "list"]` prefix so the list
 * refetches and the new reminder appears. Submit is disabled while empty or while the add is in
 * flight (so a double-tap can't double-create).
 */
export function AddTodoForm() {
    const c = useThemeColors();
    const [title, setTitle] = useState("");
    const addTodo = useAddTodo();

    const trimmed = title.trim();
    const canSubmit = trimmed.length > 0 && !addTodo.isPending;

    const submit = (): void => {
        if (!canSubmit) {
            return;
        }

        addTodo.mutate({ title: trimmed });
        setTitle("");
    };

    return (
        <Card className="flex-row items-center gap-2">
            <TextInput
                testID="reminders-todos-add-input"
                accessibilityLabel="new reminder title"
                placeholder="New reminder…"
                placeholderTextColor={c.textMuted}
                value={title}
                onChangeText={setTitle}
                onSubmitEditing={submit}
                returnKeyType="done"
                autoCapitalize="sentences"
                autoCorrect
                className="flex-1 rounded-lg border border-dd-border bg-dd-bg-base px-3 py-2"
                style={{ color: c.textPrimary, fontFamily: "monospace" }}
            />
            <Pressable
                testID="reminders-todos-add-submit"
                accessibilityRole="button"
                accessibilityLabel="add reminder"
                disabled={!canSubmit}
                onPress={submit}
                className="rounded-lg px-4 py-2"
                style={{ backgroundColor: canSubmit ? c.accent : c.border, opacity: canSubmit ? 1 : 0.6 }}
            >
                <Text className="font-bold" style={{ color: c.bgBase, fontFamily: "monospace" }}>
                    {addTodo.isPending ? "Adding…" : "Add"}
                </Text>
            </Pressable>
        </Card>
    );
}
