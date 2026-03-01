/**
 * CLI Theme — Ink-native colors and symbols
 *
 * Replaces chalk-based colors.ts with Ink <Text> color props.
 * Usage: <Text color={colors.success}>Done</Text>
 */

export const colors = {
    // Status
    success: "green",
    warning: "yellow",
    error: "red",
    info: "blue",
    muted: "gray",

    // Entity types
    entity: "cyan",
    count: "white",

    // Actions
    create: "green",
    update: "yellow",
    skip: "gray",
    delete: "red",

    // Headers
    header: "white",
    highlight: "cyan",
} as const;

export const symbols = {
    success: "\u2713", // ✓
    warning: "\u26A0", // ⚠
    error: "\u2717", // ✗
    info: "i",
    pending: "\u25CB", // ○
    running: "\u25CC", // ◌
    arrow: "\u2192", // →
    bullet: "\u2022", // •
    plus: "+",
    seed: "\uD83C\uDF31", // 🌱
    target: "\uD83C\uDFAF", // 🎯
    summary: "\uD83D\uDCCA", // 📊
    corner: "\u2514", // └
    branch: "\u251C", // ├
    dash: "\u2500", // ─
    changelog: "\uD83D\uDCDD", // 📝
} as const;

/**
 * Unified theme object wrapping colors and symbols for convenience.
 * Usage: theme.success, theme.arrow, etc.
 */
export const theme = {
    ...colors,
    // Additional semantic aliases
    primary: "cyan",
    accent: "magenta",
} as const;

export type RiskLevel = "safe" | "new" | "destructive";

export interface RiskBadge {
    label: string;
    color: string;
    backgroundColor: string;
}

export const riskBadges: Record<RiskLevel, RiskBadge> = {
    safe: { label: " SAFE ", color: "black", backgroundColor: "green" },
    new: { label: " NEW ", color: "black", backgroundColor: "yellow" },
    destructive: { label: " DANGER ", color: "white", backgroundColor: "red" },
};

export function getRiskBadge(risk: RiskLevel): RiskBadge {
    return riskBadges[risk] ?? riskBadges.safe;
}

export type BumpType = "major" | "minor" | "patch";

export function getBumpColor(bump: BumpType): string {
    switch (bump) {
        case "major":
            return "red";
        case "minor":
            return "yellow";
        case "patch":
            return "green";
    }
}

export type EnvironmentName = "dev" | "staging" | "prod";

export function getEnvColor(env: EnvironmentName): string {
    switch (env) {
        case "dev":
            return "blue";
        case "staging":
            return "yellow";
        case "prod":
            return "red";
    }
}
