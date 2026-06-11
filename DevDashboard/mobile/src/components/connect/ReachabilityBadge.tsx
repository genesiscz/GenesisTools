import { Text, View } from "react-native";
import { useThemeColors } from "@/theme/colors";
import type { ReachState } from "@/transport/reachability";

const LABELS: Record<ReachState["kind"], string> = {
    idle: "Not connected",
    probing: "Checking…",
    reachable: "Connected",
    unreachable: "Unreachable",
    "needs-vpn": "Turn on Tailscale",
    "needs-pair": "Pair this device",
};

type Tone = { fg: string; border: string; bg: string; dot: boolean };

function tone(kind: ReachState["kind"], c: ReturnType<typeof useThemeColors>): Tone {
    if (kind === "reachable") {
        return { fg: c.accent, border: c.accent, bg: c.accentMuted, dot: true };
    }

    if (kind === "unreachable") {
        return { fg: c.danger, border: c.danger, bg: "transparent", dot: true };
    }

    if (kind === "probing") {
        return { fg: c.textSecondary, border: c.border, bg: "transparent", dot: true };
    }

    return { fg: c.textMuted, border: c.border, bg: "transparent", dot: false };
}

/**
 * Reachability status pill in the Obsidian-Terminal badge style: mono uppercase, tinted by state,
 * with a leading status dot for live/probing/failed states. Keeps the stable `reachability-badge`
 * and `reachability-<kind>` accessibility labels the e2e specs locate by.
 */
export function ReachabilityBadge({ state }: { state: ReachState }) {
    const c = useThemeColors();
    const t = tone(state.kind, c);

    return (
        <View
            accessibilityLabel="reachability-badge"
            accessibilityRole="text"
            className="flex-row items-center gap-2 self-start rounded-full border px-3 py-1.5"
            style={{ borderColor: t.border, backgroundColor: t.bg }}
        >
            {t.dot ? <View className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: t.fg }} /> : null}
            <Text
                accessibilityLabel={`reachability-${state.kind}`}
                className="text-[11px] font-bold uppercase tracking-[0.16em]"
                style={{ color: t.fg, fontFamily: "monospace" }}
            >
                {LABELS[state.kind]}
            </Text>
        </View>
    );
}
