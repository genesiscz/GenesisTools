import type { AgentBoardSession } from "@dd/contract";
import { Pressable, Text, View } from "react-native";
import { useThemeColors } from "@/theme/colors";

/**
 * A destination list of live sessions (a memo's task, a snapped photo). It lists every session the board returned:
 * the screens around it scroll, and a session cut off the end could not be reached at all.
 */
export function SessionPicker({
    sessions,
    onPick,
    disabled = false,
    testIDPrefix,
}: {
    sessions: AgentBoardSession[];
    onPick: (session: AgentBoardSession) => void;
    disabled?: boolean;
    testIDPrefix?: string;
}) {
    const c = useThemeColors();

    return (
        <View className="gap-1">
            {sessions.map((session) => (
                <Pressable
                    key={session.key}
                    testID={testIDPrefix ? `${testIDPrefix}${session.key}` : undefined}
                    accessibilityRole="button"
                    disabled={disabled}
                    onPress={() => onPick(session)}
                    className="rounded-xl px-3 py-2.5"
                    style={{ borderWidth: 1, borderColor: c.border, opacity: disabled ? 0.5 : 1 }}
                >
                    <Text numberOfLines={1} style={{ color: c.textPrimary, fontSize: 13 }}>
                        {`${session.project ?? session.provider} · ${session.title ?? session.label}`}
                    </Text>
                </Pressable>
            ))}
            {sessions.length === 0 ? <Text style={{ color: c.textMuted, fontSize: 12 }}>No live session.</Text> : null}
        </View>
    );
}
