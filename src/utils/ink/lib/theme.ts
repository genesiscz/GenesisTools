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
