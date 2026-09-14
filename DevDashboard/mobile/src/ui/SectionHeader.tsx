import { Text } from "react-native";
import { useThemeColors } from "@/theme/colors";

interface SectionHeaderProps {
    title: string;
    testID?: string;
    /** Force the legacy all-caps "eyebrow" treatment for a deliberate small label. Default: normal case. */
    uppercase?: boolean;
}

/**
 * Shared section header used at the top of cards/sections (the "Obsidian Terminal" look). Mono accent,
 * NORMAL case by default — section TITLES like "Tmux sessions" should read as titles, not be shouted in
 * all-caps (per user feedback 2026-06-01). Pass `uppercase` for a deliberate eyebrow-style micro-label.
 * Tier-1 primitive — feature agents consume, never modify.
 */
export function SectionHeader({ title, testID, uppercase = false }: SectionHeaderProps) {
    const c = useThemeColors();

    return (
        <Text
            testID={testID}
            accessibilityRole="header"
            className={uppercase ? "text-sm font-bold uppercase tracking-widest" : "text-base font-semibold tracking-wide"}
            style={{ color: c.accent, fontFamily: "monospace" }}
        >
            {title}
        </Text>
    );
}
