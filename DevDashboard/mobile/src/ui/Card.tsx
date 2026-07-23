import type { ReactNode } from "react";
import { type StyleProp, View, type ViewStyle } from "react-native";
import { cn } from "@/lib/cn";
import { useThemeColors } from "@/theme/colors";

interface CardProps {
    children: ReactNode;
    testID?: string;
    /** Extra classes appended to the inner surface (layout/padding/gap). The base `bg-dd-bg-panel`
     *  / `border` surface is NOT overridable here by design — pass layout, not a new background. */
    className?: string;
    /** Inline style for cases NativeWind can't express (e.g. `flexBasis` for a 2-up grid). */
    style?: StyleProp<ViewStyle>;
    /**
     * When true, render the full Obsidian-Terminal "double-bezel" treatment: a translucent glass
     * outer shell wrapping a solid inner core (concentric radii) with a top inset highlight. The
     * default (false) keeps the cheaper single-layer panel so existing screens are unchanged.
     */
    bezel?: boolean;
    /** Featured variant — emerald-tinted ring + a hair brighter core (the "primary" card). */
    featured?: boolean;
}

/**
 * Panel surface using the ported `--dd-bg-panel` / `--dd-border` tokens (the "Obsidian Terminal"
 * look). Two modes:
 *  - default (`bezel` omitted): a single rounded panel — unchanged from before, every existing
 *    screen keeps its look + the stable `gap-2 … p-4` inner surface.
 *  - `bezel`: the signature double-bezel — outer translucent shell (`p-1.5`) + inner core whose
 *    radius is `outer − padding` so corners stay concentric, plus a `border-t border-white/10`
 *    top hairline standing in for the web `.inset-hi` lit-bevel highlight.
 *
 * Forwards `testID`, `className`, and `style` (D32 reference screens — e.g. `KpiCard` — need
 * `style={{ flexBasis }}` for the grid and append layout classes). `cn()` merges the caller's
 * classes onto the inner surface so it stays consistent while layout is customizable.
 */
export function Card({ children, testID, className, style, bezel = false, featured = false }: CardProps) {
    const c = useThemeColors();

    if (!bezel) {
        return (
            <View
                testID={testID}
                accessibilityLabel={testID}
                className={cn("gap-2 rounded-2xl border border-dd-border bg-dd-bg-panel p-4", className)}
                style={[{ borderCurve: "continuous" }, style]}
            >
                {children}
            </View>
        );
    }

    return (
        <View
            testID={testID}
            accessibilityLabel={testID}
            className="rounded-[28px] border bg-white/[0.03] p-1.5"
            style={[
                { borderCurve: "continuous", borderColor: featured ? c.accentGlow : "rgba(255,255,255,0.10)" },
                style,
            ]}
        >
            <View
                className={cn("gap-2 rounded-[22px] border-t border-white/10 bg-dd-bg-panel p-4", className)}
                style={{ borderCurve: "continuous" }}
            >
                {children}
            </View>
        </View>
    );
}
