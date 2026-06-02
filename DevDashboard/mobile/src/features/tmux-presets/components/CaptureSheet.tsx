import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { Card } from "@/ui/Card";
import { useCapturePreset } from "@/features/tmux-presets/hooks";
import { useThemeColors } from "@/theme/colors";

/**
 * "Capture current layout" affordance (feature-local). A name `TextInput` + an optional note
 * `TextInput` + a submit `Pressable` over `useCapturePreset()`; on success the mutation invalidates
 * the `["tmux-presets", "list"]` key so the list refetches and the new preset appears. Submit is
 * disabled while the name is empty or the capture is in flight (so a double-tap can't double-save).
 */
export function CaptureSheet() {
    const c = useThemeColors();
    const [name, setName] = useState("");
    const [note, setNote] = useState("");
    const capture = useCapturePreset();

    const trimmedName = name.trim();
    const trimmedNote = note.trim();
    const canSubmit = trimmedName.length > 0 && !capture.isPending;

    const submit = (): void => {
        if (!canSubmit) {
            return;
        }

        capture.mutate({ name: trimmedName, note: trimmedNote || undefined });
        setName("");
        setNote("");
    };

    return (
        <Card className="gap-2">
            <Text className="text-xs font-bold uppercase tracking-widest" style={{ color: c.textMuted, fontFamily: "monospace" }}>
                Capture current layout
            </Text>
            <TextInput
                testID="tmux-presets-capture-name"
                accessibilityLabel="preset name"
                placeholder="Preset name…"
                placeholderTextColor={c.textMuted}
                value={name}
                onChangeText={setName}
                returnKeyType="next"
                autoCapitalize="none"
                autoCorrect={false}
                className="rounded-lg border border-dd-border bg-dd-bg-base px-3 py-2"
                style={{ color: c.textPrimary, fontFamily: "monospace" }}
            />
            <TextInput
                testID="tmux-presets-capture-note"
                accessibilityLabel="preset note"
                placeholder="Note (optional)…"
                placeholderTextColor={c.textMuted}
                value={note}
                onChangeText={setNote}
                onSubmitEditing={submit}
                returnKeyType="done"
                autoCapitalize="sentences"
                className="rounded-lg border border-dd-border bg-dd-bg-base px-3 py-2"
                style={{ color: c.textPrimary, fontFamily: "monospace" }}
            />
            <Pressable
                testID="tmux-presets-capture-submit"
                accessibilityRole="button"
                accessibilityLabel="capture current layout"
                disabled={!canSubmit}
                onPress={submit}
                className="items-center rounded-lg px-4 py-2"
                style={{ backgroundColor: canSubmit ? c.accent : c.border, opacity: canSubmit ? 1 : 0.6 }}
            >
                <Text className="font-bold" style={{ color: c.bgBase, fontFamily: "monospace" }}>
                    {capture.isPending ? "Capturing…" : "Capture current layout"}
                </Text>
            </Pressable>
        </Card>
    );
}
