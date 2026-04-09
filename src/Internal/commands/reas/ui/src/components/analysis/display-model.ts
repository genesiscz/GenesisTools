import type { DashboardExport } from "@app/Internal/commands/reas/lib/api-export";
import { getInvestmentSummary, getScoreTone } from "./utils";

export const GRADE_COLORS: Record<string, string> = {
    A: "text-emerald-400 border-emerald-500/30 bg-emerald-500/10",
    B: "text-cyan-400 border-cyan-500/30 bg-cyan-500/10",
    C: "text-amber-400 border-amber-500/30 bg-amber-500/10",
    D: "text-orange-400 border-orange-500/30 bg-orange-500/10",
    F: "text-red-400 border-red-500/30 bg-red-500/10",
    "N/A": "text-slate-300 border-white/10 bg-white/5",
};

export const GRADE_GLOW: Record<string, string> = {
    A: "drop-shadow-[0_0_8px_rgba(74,222,128,0.4)]",
    B: "drop-shadow-[0_0_8px_rgba(34,211,238,0.4)]",
    C: "drop-shadow-[0_0_8px_rgba(251,191,36,0.4)]",
    D: "drop-shadow-[0_0_8px_rgba(251,146,60,0.4)]",
    F: "drop-shadow-[0_0_8px_rgba(248,113,113,0.4)]",
    "N/A": "",
};

export const RECOMMENDATION_COLORS: Record<string, { bg: string; text: string }> = {
    "strong-buy": { bg: "bg-green-500/15 border-green-500/30", text: "text-green-400" },
    buy: { bg: "bg-lime-500/15 border-lime-500/30", text: "text-lime-400" },
    hold: { bg: "bg-amber-500/15 border-amber-500/30", text: "text-amber-400" },
    avoid: { bg: "bg-orange-500/15 border-orange-500/30", text: "text-orange-400" },
    "strong-avoid": { bg: "bg-red-500/15 border-red-500/30", text: "text-red-400" },
};

export const RECOMMENDATION_LABELS: Record<string, string> = {
    "strong-buy": "Strong Buy",
    buy: "Buy",
    hold: "Hold",
    avoid: "Avoid",
    "strong-avoid": "Strong Avoid",
    unavailable: "Unavailable",
};

export function getScoreCardModel(data: DashboardExport) {
    const summary = getInvestmentSummary(data);
    const recommendation = normalizeRecommendation(summary.recommendation);

    return {
        grade: summary.grade,
        gradeClassName: GRADE_COLORS[summary.grade] ?? GRADE_COLORS.C,
        glowClassName: GRADE_GLOW[summary.grade] ?? GRADE_GLOW.C,
        score: summary.overall,
        scoreToneClassName: getScoreTone(summary.overall),
        recommendation,
        recommendationLabel: RECOMMENDATION_LABELS[recommendation],
        recommendationClassName: RECOMMENDATION_COLORS[recommendation] ?? RECOMMENDATION_COLORS.hold,
        reasoning: summary.reasoning,
        isPositive: summary.overall >= 50,
    };
}

export function getMomentumCardModel(data: DashboardExport) {
    const momentum = data.analysis.momentum;

    if (!momentum) {
        return {
            direction: "stable",
            directionLabel: "Stable",
            directionClassName: "text-amber-400",
            velocityPerPeriodLabel: "+0.0% per period",
            momentum: "linear",
            momentumLabel: "Linear",
            momentumClassName: "text-gray-400 border-white/10 bg-white/5",
            confidencePercent: 0,
            confidenceClassName: "bg-red-500",
            interpretation: "Momentum data not available",
        };
    }

    const directionClassName =
        momentum.direction === "rising"
            ? "text-green-400"
            : momentum.direction === "declining"
              ? "text-red-400"
              : "text-amber-400";

    const momentumClassName =
        momentum.momentum === "accelerating"
            ? "text-cyan-400 border-cyan-500/30 bg-cyan-500/10"
            : momentum.momentum === "decelerating"
              ? "text-orange-400 border-orange-500/30 bg-orange-500/10"
              : "text-gray-400 border-white/10 bg-white/5";

    const confidencePercent = momentum.confidence === "high" ? 85 : momentum.confidence === "medium" ? 60 : 35;

    return {
        direction: momentum.direction,
        directionLabel: capitalize(momentum.direction),
        directionClassName,
        velocityPerPeriodLabel: `${momentum.priceVelocity >= 0 ? "+" : ""}${momentum.priceVelocity.toFixed(1)}% per period`,
        momentum: momentum.momentum,
        momentumLabel: capitalize(momentum.momentum),
        momentumClassName,
        confidencePercent,
        confidenceClassName:
            confidencePercent >= 70 ? "bg-green-500" : confidencePercent >= 40 ? "bg-amber-500" : "bg-red-500",
        interpretation: momentum.interpretation,
    };
}

function normalizeRecommendation(recommendation: string): string {
    const value = recommendation.toLowerCase().replace(/\s+/g, "-");

    if (value in RECOMMENDATION_LABELS) {
        return value;
    }

    return "hold";
}

function capitalize(value: string): string {
    return value.charAt(0).toUpperCase() + value.slice(1);
}
