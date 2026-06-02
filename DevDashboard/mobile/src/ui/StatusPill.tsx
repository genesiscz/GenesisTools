import { Text, View } from "react-native";
import { useThemeColors } from "@/theme/colors";

export type PillTone = "accent" | "muted" | "danger";

interface StatusPillProps {
    label: string;
    tone?: PillTone;
    /** Show a leading glowing status dot (the web "live" indicator look) instead of a text bullet. */
    dot?: boolean;
    /** Render the label in normal case instead of the all-caps eyebrow default. */
    normalCase?: boolean;
    testID?: string;
}

/**
 * Shared small status pill (the "Obsidian Terminal" badge look): rounded, bordered, mono, tinted by
 * tone. When `dot` is set it shows a REAL glowing dot (a tinted circle with an emerald glow via
 * boxShadow — web parity, replacing the old `●` text bullet). Tier-1 primitive — reuse for connection
 * status, "mock data", live/idle, counts. Callers pass a pre-resolved label.
 */
export function StatusPill({ label, tone = "accent", dot = false, normalCase = false, testID }: StatusPillProps) {
    const c = useThemeColors();
    const fg = tone === "danger" ? c.danger : tone === "muted" ? c.textMuted : c.accent;
    const bg = tone === "accent" ? c.accentMuted : "transparent";

    return (
        <View
            testID={testID}
            accessibilityLabel={label}
            className="flex-row items-center gap-1.5 self-start rounded-full px-2 py-0.5"
            style={{ backgroundColor: bg, borderWidth: 1, borderColor: c.border }}
        >
            {dot ? (
                <View
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: fg, boxShadow: `0 0 6px ${fg}` }}
                />
            ) : null}
            <Text
                className={normalCase ? "text-[10px] font-bold tracking-wide" : "text-[10px] font-bold uppercase tracking-widest"}
                style={{ color: fg, fontFamily: "monospace" }}
            >
                {label}
            </Text>
        </View>
    );
}
