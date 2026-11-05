import type { AgentBoardLabel } from "@dd/contract";
import { Text, View } from "react-native";
import { type ThemeColors, useThemeColors } from "@/theme/colors";

type Tone = "running" | "attention" | "danger" | "quiet";

/**
 * The word and tone of each fleet label (`FLEET_PHASES` on the Mac). Exhaustive, so a new label fails to compile
 * until it has a row here.
 */
export const PHASE_BADGES: Record<AgentBoardLabel, { word: string; tone: Tone; dot: boolean }> = {
    thinking: { word: "Thinking", tone: "running", dot: true },
    tool: { word: "Tool", tone: "running", dot: true },
    waiting: { word: "Waiting", tone: "attention", dot: true },
    interrupted: { word: "Interrupted", tone: "attention", dot: false },
    stalled: { word: "Stalled", tone: "danger", dot: true },
    idle: { word: "Idle", tone: "quiet", dot: false },
    unknown: { word: "Unknown", tone: "quiet", dot: false },
};

function toneColor(tone: Tone, c: ThemeColors): string {
    const colors: Record<Tone, string> = {
        running: c.accent,
        attention: c.warning,
        danger: c.danger,
        quiet: c.textMuted,
    };
    return colors[tone];
}

export function PhaseBadge({ label, testID }: { label: AgentBoardLabel; testID?: string }) {
    const c = useThemeColors();
    const badge = PHASE_BADGES[label];
    const fg = toneColor(badge.tone, c);

    return (
        <View
            testID={testID}
            accessibilityLabel={`phase ${badge.word}`}
            className="flex-row items-center gap-1.5 self-start rounded-full px-2 py-0.5"
            style={{ borderWidth: 1, borderColor: fg }}
        >
            {badge.dot ? (
                <View className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: fg, boxShadow: `0 0 6px ${fg}` }} />
            ) : null}
            <Text className="text-[10px] font-bold tracking-wide" style={{ color: fg, fontFamily: "monospace" }}>
                {badge.word}
            </Text>
        </View>
    );
}
