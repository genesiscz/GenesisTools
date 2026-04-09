// ============================================================================
// UI THEMES
// Apply via className on <html> or any wrapping element:
//   <html className="vowen">   → Vowen violet/purple palette
//   <html className="cyberpunk"> → Cyberpunk amber/cyan palette
//   (no class) → default dark palette
// ============================================================================

export type ThemeName = "wow" | "cyberpunk" | "default";

export const wowTheme = {
    name: "wow" as const,
    colors: {
        bg: {
            primary: "#050507",
            secondary: "#0a0a0f",
            card: "#111116",
            cardHover: "#16161d",
            elevated: "#1a1a22",
        },
        border: {
            default: "#1e1e28",
            light: "#2a2a38",
            subtle: "#252530",
        },
        text: {
            primary: "#f4f4f5",
            secondary: "#a1a1aa",
            muted: "#52525b",
            dim: "#3f3f46",
        },
        accent: {
            violet: "#7c3aed",
            violetLight: "#a78bfa",
            violetDark: "#5b21b6",
            purple: "#8b5cf6",
            pink: "#ec4899",
            rose: "#f43f5e",
            orange: "#f97316",
            amber: "#f59e0b",
            emerald: "#10b981",
            cyan: "#06b6d4",
            sky: "#0ea5e9",
            blue: "#3b82f6",
            indigo: "#6366f1",
        },
    },
    radii: {
        sm: "8px",
        md: "12px",
        lg: "16px",
        xl: "20px",
        "2xl": "24px",
        full: "9999px",
    },
    shadows: {
        card: "0 4px 24px rgba(0,0,0,0.3)",
        cardHover: "0 20px 40px rgba(0,0,0,0.4), 0 0 60px rgba(124,58,237,0.1)",
        glow: "0 0 60px rgba(124,58,237,0.15)",
    },
};

export const cyberpunkTheme = {
    name: "cyberpunk" as const,
    colors: {
        bg: {
            primary: "#0d0d14",
            secondary: "#111118",
            card: "#121219",
            cardHover: "#17171f",
            elevated: "#1c1c26",
        },
        border: {
            default: "#33330d",
            light: "#4d4d14",
            subtle: "#2a2a0d",
        },
        text: {
            primary: "#ededed",
            secondary: "#a3a3a3",
            muted: "#666666",
            dim: "#404040",
        },
        accent: {
            amber: "#f59e0b",
            amberLight: "#fbbf24",
            amberDark: "#d97706",
            cyan: "#06b6d4",
            cyanLight: "#22d3ee",
            green: "#22c55e",
            red: "#ef4444",
            purple: "#a855f7",
        },
    },
    radii: {
        sm: "6px",
        md: "10px",
        lg: "16px",
        xl: "20px",
        "2xl": "24px",
        full: "9999px",
    },
    shadows: {
        card: "0 4px 24px rgba(0,0,0,0.4)",
        cardHover: "0 20px 40px rgba(0,0,0,0.5), 0 0 60px rgba(245,158,11,0.1)",
        glow: "0 0 60px rgba(245,158,11,0.15)",
    },
};

export const themes = {
    wow: wowTheme,
    cyberpunk: cyberpunkTheme,
} satisfies Record<string, { name: ThemeName }>;
