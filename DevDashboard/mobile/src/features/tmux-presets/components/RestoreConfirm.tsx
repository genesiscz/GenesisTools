import { Modal, Pressable, Text, View } from "react-native";
import { useThemeColors } from "@/theme/colors";

export type ConfirmAction = "restore" | "delete";

export interface ConfirmState {
    action: ConfirmAction;
    name: string;
}

interface Props {
    state: ConfirmState | null;
    busy: boolean;
    onCancel: () => void;
    onConfirm: () => void;
}

/**
 * Shared confirm dialog for Restore + Delete (feature-local — no shared Button/Dialog primitive
 * exists; `src/ui` is read-only for features). An RN `<Modal transparent>` with a themed card. Driven
 * by a `ConfirmState | null` so it renders ONCE at screen level. Restore copy notes that the captured
 * last command is pre-typed (not auto-run) — matches `restoreTmuxSession`'s replay-without-Enter.
 *
 * The `tmux-presets-confirm` root is the load-bearing Appium assertion: it proves an explicit dialog
 * appears before either mutation runs (a tap alone never mutates the live host).
 */
export function RestoreConfirm({ state, busy, onCancel, onConfirm }: Props) {
    const c = useThemeColors();

    if (!state) {
        return null;
    }

    const isRestore = state.action === "restore";
    const title = isRestore ? `Restore "${state.name}"?` : `Delete "${state.name}"?`;
    const body = isRestore
        ? "Recreates the saved tmux sessions on the connected machine. Existing sessions are skipped; the captured last command is pre-typed, not run."
        : "Removes the preset file. This does not touch any running tmux sessions.";
    const confirmLabel = isRestore ? "Restore" : "Delete";
    const confirmColor = isRestore ? c.accent : c.danger;

    return (
        <Modal transparent animationType="fade" visible onRequestClose={onCancel}>
            <Pressable
                onPress={onCancel}
                className="flex-1 items-center justify-center p-6"
                style={{ backgroundColor: "rgba(0,0,0,0.6)" }}
            >
                <Pressable
                    testID="tmux-presets-confirm"
                    accessibilityLabel="tmux-presets-confirm"
                    onPress={() => undefined}
                    className="w-full max-w-md gap-3 rounded-2xl border border-dd-border bg-dd-bg-panel p-5"
                    style={{ borderCurve: "continuous" }}
                >
                    <Text
                        testID="tmux-presets-confirm-title"
                        className="text-base font-bold"
                        style={{ color: c.textPrimary, fontFamily: "monospace" }}
                    >
                        {title}
                    </Text>
                    <Text className="text-xs" style={{ color: c.textMuted, fontFamily: "monospace" }}>
                        {body}
                    </Text>

                    <View className="mt-1 flex-row justify-end gap-2">
                        <Pressable
                            testID="tmux-presets-confirm-cancel"
                            accessibilityRole="button"
                            accessibilityLabel="cancel"
                            disabled={busy}
                            onPress={onCancel}
                            className="rounded-lg border border-dd-border px-4 py-2"
                        >
                            <Text className="font-bold" style={{ color: c.textSecondary, fontFamily: "monospace" }}>
                                Cancel
                            </Text>
                        </Pressable>
                        <Pressable
                            testID="tmux-presets-confirm-accept"
                            accessibilityRole="button"
                            accessibilityLabel={confirmLabel}
                            disabled={busy}
                            onPress={onConfirm}
                            className="rounded-lg px-4 py-2"
                            style={{ backgroundColor: confirmColor, opacity: busy ? 0.6 : 1 }}
                        >
                            <Text className="font-bold" style={{ color: c.bgBase, fontFamily: "monospace" }}>
                                {busy ? "Working…" : confirmLabel}
                            </Text>
                        </Pressable>
                    </View>
                </Pressable>
            </Pressable>
        </Modal>
    );
}
