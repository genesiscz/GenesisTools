import type { AgentBoardSession } from "@dd/contract";
import { Pressable, Text } from "react-native";
import { usePingWatch } from "@/features/agents/hooks";
import { useThemeColors } from "@/theme/colors";

/**
 * "Ping me when done" (F15): the Mac watches this session and pushes once when its turn ends, with the agent's last
 * lines. The Mac does the watching, because the phone's stream stops in the background. A second tap stops it.
 */
export function PingButton({ session }: { session: AgentBoardSession }) {
    const c = useThemeColors();
    const { watched, loading, toggle } = usePingWatch(session);

    return (
        <Pressable
            testID="btn-ping-when-done"
            accessibilityRole="button"
            accessibilityLabel={watched ? "Stop the ping when this turn ends" : "Ping me when this turn ends"}
            accessibilityState={{ selected: watched, disabled: toggle.isPending }}
            disabled={toggle.isPending || loading}
            onPress={() => toggle.mutate()}
            className="items-center rounded-xl py-2.5"
            style={{ borderWidth: 1, borderColor: watched ? c.accent : c.border, opacity: toggle.isPending ? 0.6 : 1 }}
        >
            <Text style={{ color: watched ? c.accent : c.textPrimary, fontWeight: "600" }}>
                {toggle.isError ? `Not set: ${String(toggle.error)}` : watched ? "Pings when done ✓" : "Ping me when done"}
            </Text>
        </Pressable>
    );
}
