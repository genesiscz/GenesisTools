/**
 * Concrete `--dd-*` token VALUES (dark-only "Obsidian Terminal" palette), mirroring
 * `src/theme/tokens.css` 1:1. NativeWind classNames (`bg-dd-bg-panel`, …) cover normal RN views,
 * but **Skia / victory-native cannot read classNames or CSS vars at runtime** — chart strokes and
 * gradients need concrete hex. `useThemeColors()` is the single resolver for those cases (and any
 * place that needs an inline `style={{ color }}`). Keep the KEYS stable: when the NativeWind v5
 * (`@theme`) migration lands, only the source of these values changes, not the call sites.
 *
 * The web dashboard ships a single dark palette, so this is intentionally not light/dark-aware
 * (unlike the template's `useTheme()` which returns light/dark `Colors`). Mirrors the ported
 * tokens — do not invent new colors here; add a token to tokens.css + tailwind.config.js first.
 */

export interface ThemeColors {
    bgBase: string;
    bgPanel: string;
    border: string;
    grid: string;
    /** Primary accent (emerald). Use for chart strokes, headers, active states. */
    accent: string;
    /** Secondary accent (teal) — the gradient/"to" end + connected status. */
    accentTo: string;
    accentGlow: string;
    /** Translucent accent fill, e.g. an active segment background. */
    accentMuted: string;
    /** Area-gradient stops (top → bottom): opaque accent fading to transparent. */
    accentGradientFrom: string;
    accentGradientTo: string;
    textPrimary: string;
    textSecondary: string;
    textMuted: string;
    danger: string;
}

const DD_COLORS: ThemeColors = {
    bgBase: "#0c0e10",
    bgPanel: "#101316",
    border: "#1e2428",
    grid: "rgba(52, 211, 153, 0.04)",
    accent: "#34d399",
    accentTo: "#2dd4bf",
    accentGlow: "rgba(52, 211, 153, 0.35)",
    accentMuted: "rgba(52, 211, 153, 0.12)",
    accentGradientFrom: "rgba(52, 211, 153, 0.55)",
    accentGradientTo: "rgba(52, 211, 153, 0.02)",
    textPrimary: "#e6edf3",
    textSecondary: "#8b96a0",
    textMuted: "#5b6670",
    danger: "#f87171",
};

/** Concrete `--dd-*` color values for Skia/inline-style consumers. Dark-only (see file header). */
export function useThemeColors(): ThemeColors {
    return DD_COLORS;
}
