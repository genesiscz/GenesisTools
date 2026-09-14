import { Modal, Pressable, Text, View } from "react-native";
import { Card } from "@/ui/Card";
import { useThemeColors } from "@/theme/colors";

interface KillConfirmDialogProps {
    visible: boolean;
    port: number | null;
    command: string | null;
    onConfirm: () => void;
    onCancel: () => void;
}

/**
 * In-app confirm dialog gating a port kill. Uses RN `Modal` (not native `Alert`) so Appium can find
 * `port-killer-kill-confirm` and its yes/cancel buttons. testIDs:
 * `port-killer-kill-confirm`, `port-killer-kill-confirm-yes`, `port-killer-kill-confirm-cancel`.
 */
export function KillConfirmDialog({ visible, port, command, onConfirm, onCancel }: KillConfirmDialogProps) {
    const c = useThemeColors();

    return (
        <Modal transparent animationType="fade" visible={visible} onRequestClose={onCancel}>
            <View className="flex-1 items-center justify-center bg-black/60 p-6">
                <Card testID="port-killer-kill-confirm" className="w-full max-w-sm gap-4">
                    <Text className="text-base font-bold" style={{ color: c.textPrimary, fontFamily: "monospace" }}>
                        Kill :{port}?
                    </Text>
                    <Text className="text-xs" style={{ color: c.textSecondary, fontFamily: "monospace" }}>
                        Sends SIGTERM to {command ?? "the owning process"}. Unsaved work in that process is lost.
                    </Text>
                    <View className="flex-row justify-end gap-3">
                        <Pressable
                            testID="port-killer-kill-confirm-cancel"
                            accessibilityRole="button"
                            accessibilityLabel="Cancel"
                            onPress={onCancel}
                            className="rounded-lg px-4 py-2"
                            style={{ borderWidth: 1, borderColor: c.border }}
                        >
                            <Text style={{ color: c.textSecondary, fontFamily: "monospace" }}>Cancel</Text>
                        </Pressable>
                        <Pressable
                            testID="port-killer-kill-confirm-yes"
                            accessibilityRole="button"
                            accessibilityLabel="Kill"
                            onPress={onConfirm}
                            className="rounded-lg px-4 py-2"
                            style={{ backgroundColor: c.danger }}
                        >
                            <Text className="font-bold" style={{ color: c.bgBase, fontFamily: "monospace" }}>
                                Kill
                            </Text>
                        </Pressable>
                    </View>
                </Card>
            </View>
        </Modal>
    );
}
