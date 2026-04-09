export interface MarketMomentum {
    priceVelocity: number;
    direction: "rising" | "stable" | "declining";
    momentum: "accelerating" | "linear" | "decelerating";
    confidence: "high" | "medium" | "low";
    interpretation: string;
}

import type { TrendPeriod } from "@app/Internal/commands/reas/analysis/trends";

type TrendPeriodInput = Pick<TrendPeriod, "medianPerM2" | "count">;

export function detectMomentum(periods: TrendPeriodInput[]): MarketMomentum {
    if (periods.length < 2) {
        return {
            priceVelocity: 0,
            direction: "stable",
            momentum: "linear",
            confidence: "low",
            interpretation: "Insufficient data — need at least 2 quarters",
        };
    }

    // Calculate period-over-period changes
    const changes: number[] = [];

    for (let i = 1; i < periods.length; i++) {
        const prev = periods[i - 1].medianPerM2;
        const curr = periods[i].medianPerM2;

        if (prev > 0) {
            changes.push(((curr - prev) / prev) * 100);
        }
    }

    if (changes.length === 0) {
        return {
            priceVelocity: 0,
            direction: "stable",
            momentum: "linear",
            confidence: "low",
            interpretation: "No valid price changes to analyze",
        };
    }

    // Average velocity (% per period)
    const avgChange = changes.reduce((a, b) => a + b, 0) / changes.length;
    const lastChange = changes[changes.length - 1];

    // Direction
    let direction: MarketMomentum["direction"];

    if (avgChange > 1) {
        direction = "rising";
    } else if (avgChange < -1) {
        direction = "declining";
    } else {
        direction = "stable";
    }

    // Momentum: compare rate of change
    let momentum: MarketMomentum["momentum"] = "linear";

    if (changes.length >= 2) {
        const recentChanges = changes.slice(-2);
        const acceleration = recentChanges[1] - recentChanges[0];

        if (Math.abs(acceleration) < 0.5) {
            momentum = "linear";
        } else if ((direction === "rising" && acceleration > 0) || (direction === "declining" && acceleration < 0)) {
            momentum = "accelerating";
        } else {
            momentum = "decelerating";
        }
    }

    // Confidence based on sample sizes and period count
    const totalSamples = periods.reduce((sum, p) => sum + p.count, 0);
    let confidence: MarketMomentum["confidence"];

    if (changes.length >= 3 && totalSamples >= 30) {
        confidence = "high";
    } else if (changes.length >= 2 && totalSamples >= 15) {
        confidence = "medium";
    } else {
        confidence = "low";
    }

    // Human-readable interpretation
    const dirLabel = direction === "rising" ? "rising" : direction === "declining" ? "falling" : "flat";
    const momLabel = momentum === "accelerating" ? "accelerating" : momentum === "decelerating" ? "slowing" : "steady";

    return {
        priceVelocity: Math.round(avgChange * 10) / 10,
        direction,
        momentum,
        confidence,
        interpretation: `Market is ${dirLabel} at ${Math.abs(avgChange).toFixed(1)}%/quarter (${momLabel}). Last quarter: ${lastChange > 0 ? "+" : ""}${lastChange.toFixed(1)}%.`,
    };
}
