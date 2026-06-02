import { Feather } from "@expo/vector-icons";
import { Pressable, Text, View } from "react-native";
import { Card } from "@/ui/Card";
import { useRequestTodosAccess } from "@/features/reminders-todos/hooks";
import { useThemeColors } from "@/theme/colors";

/**
 * Feature-local permission-denied banner. The GET /api/todos route returns HTTP 503 when Reminders
 * access is denied, which the contract client surfaces as a thrown Error — the screen branches on the
 * error message and renders THIS instead of crashing. The shared `@/ui/Banner` is `ConnStatus`-typed
 * and can't carry a permission message, so this is built feature-local (do NOT modify the shared
 * Banner — parallel-edit conflict). "Grant access" calls POST /api/todos/request-access, then the
 * mutation invalidates the list so it refetches once permission is granted.
 */
export function PermissionBanner() {
    const c = useThemeColors();
    const requestAccess = useRequestTodosAccess();

    return (
        <Card testID="reminders-todos-permission-banner" className="gap-3" style={{ borderColor: c.danger }}>
            <View className="flex-row items-center gap-2">
                <Feather name="lock" size={16} color={c.danger} />
                <Text className="flex-1 text-sm font-bold" style={{ color: c.danger, fontFamily: "monospace" }}>
                    Reminders access denied
                </Text>
            </View>
            <Text className="text-xs" style={{ color: c.textMuted, fontFamily: "monospace" }}>
                Grant access in System Settings → Privacy & Security → Reminders, then try again.
            </Text>
            <Pressable
                testID="reminders-todos-grant-access"
                accessibilityRole="button"
                accessibilityLabel="grant reminders access"
                disabled={requestAccess.isPending}
                onPress={() => requestAccess.mutate()}
                className="self-start rounded-lg px-4 py-2"
                style={{ backgroundColor: c.accent, opacity: requestAccess.isPending ? 0.6 : 1 }}
            >
                <Text className="font-bold" style={{ color: c.bgBase, fontFamily: "monospace" }}>
                    {requestAccess.isPending ? "Requesting…" : "Grant access"}
                </Text>
            </Pressable>
        </Card>
    );
}
