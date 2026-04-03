import type { DashboardExport } from "@app/Internal/commands/reas/lib/api-export";
import { fmt, fmtCompactCurrency, fmtCurrency, fmtDays, fmtInteger, fmtPercentile, pct } from "./formatters";

export interface InvestmentSummary {
    overall: number;
    grade: string;
    reasoning: string[];
    recommendation: string;
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
    return fmt(value, options);
}

export function formatInteger(value: number): string {
    return fmtInteger(value);
}

export function formatCurrency(value: number): string {
    return fmtCurrency(value);
}

export function formatCompactCurrency(value: number): string {
    return fmtCompactCurrency(value);
}

export function formatPercent(value: number, digits = 1): string {
    return pct(value, { digits });
}

export function formatSignedPercent(value: number, digits = 1): string {
    return pct(value, { digits, signed: true });
}

export function formatPercentile(value: number): string {
    return fmtPercentile(value);
}

export function formatDays(value: number): string {
    return fmtDays(value);
}

export function median(values: number[]): number {
    if (values.length === 0) {
        return 0;
    }

    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);

    if (sorted.length % 2 === 0) {
        return (sorted[middle - 1] + sorted[middle]) / 2;
    }

    return sorted[middle];
}

export function getTargetPricePerM2(data: DashboardExport): number {
    if (!data.meta.target.area) {
        return 0;
    }

    return data.meta.target.price / data.meta.target.area;
}

export function getInvestmentSummary(data: DashboardExport): InvestmentSummary {
    const existing = data.analysis.investmentScore;

    if (existing) {
        return {
            overall: existing.overall,
            grade: existing.grade,
            reasoning: existing.reasoning,
            recommendation: existing.recommendation,
        };
    }

    let score = 50;
    const reasoning: string[] = [];
    const grossYield = data.analysis.yield.grossYield;

    if (grossYield >= 6) {
        score += 20;
        reasoning.push(`Strong gross yield at ${formatPercent(grossYield)}`);
    } else if (grossYield >= 4) {
        score += 10;
        reasoning.push(`Healthy gross yield at ${formatPercent(grossYield)}`);
    } else if (grossYield < 3) {
        score -= 10;
        reasoning.push(`Weak gross yield at ${formatPercent(grossYield)}`);
    }

    const percentile = data.analysis.comparables.targetPercentile;

    if (percentile < 30) {
        score += 15;
        reasoning.push(`Target pricing sits below market at the ${percentile.toFixed(0)}th percentile`);
    } else if (percentile > 70) {
        score -= 15;
        reasoning.push(`Target pricing sits above market at the ${percentile.toFixed(0)}th percentile`);
    } else {
        reasoning.push(`Target pricing is near the market midpoint at the ${percentile.toFixed(0)}th percentile`);
    }

    const comparableCount = data.analysis.comparables.count;

    if (comparableCount >= 20) {
        score += 5;
        reasoning.push(`Signal quality is strong with ${comparableCount} sold comparables`);
    } else if (comparableCount < 5) {
        score -= 10;
        reasoning.push(`Signal quality is weak with only ${comparableCount} sold comparables`);
    }

    const averageDiscount = data.analysis.discount.avgDiscount;

    if (averageDiscount > 10) {
        score += 5;
        reasoning.push(`Average listing discount of ${formatPercent(averageDiscount)} suggests pricing flexibility`);
    }

    const medianDom = data.analysis.timeOnMarket.median;

    if (medianDom < 30) {
        score += 5;
        reasoning.push(`Fast absorption with ${formatDays(medianDom)} median time on market`);
    } else if (medianDom > 120) {
        score -= 5;
        reasoning.push(`Slow absorption with ${formatDays(medianDom)} median time on market`);
    }

    const overall = Math.max(0, Math.min(100, score));
    const grade = overall >= 80 ? "A" : overall >= 65 ? "B" : overall >= 50 ? "C" : overall >= 35 ? "D" : "F";
    const recommendation =
        overall >= 80
            ? "Strong Buy"
            : overall >= 65
              ? "Buy"
              : overall >= 45
                ? "Hold"
                : overall >= 30
                  ? "Avoid"
                  : "Strong Avoid";

    return {
        overall,
        grade,
        reasoning,
        recommendation,
    };
}

export function getScoreTone(score: number): string {
    if (score >= 75) {
        return "text-green-300";
    }

    if (score >= 55) {
        return "text-amber-300";
    }

    return "text-red-300";
}

export function getSentimentTone(value: number): string {
    if (value > 0) {
        return "text-green-300";
    }

    if (value < 0) {
        return "text-red-300";
    }

    return "text-slate-300";
}

export function getConfidenceTone(confidence: string): string {
    if (confidence === "high") {
        return "text-green-300 border-green-500/20 bg-green-500/10";
    }

    if (confidence === "medium") {
        return "text-amber-300 border-amber-500/20 bg-amber-500/10";
    }

    return "text-red-300 border-red-500/20 bg-red-500/10";
}

export function getProviderCounts(data: DashboardExport) {
    const providerSummary = data.meta.providerSummary ?? [];
    const total = providerSummary.reduce((sum, item) => sum + item.count, 0);
    const providers = new Set(data.meta.providers);

    for (const item of providerSummary) {
        providers.add(item.provider);
    }

    const providerStatuses = new Map<string, boolean>();

    for (const provider of providers) {
        providerStatuses.set(provider, false);
    }

    for (const item of providerSummary) {
        if (getProviderHealth(item) !== "healthy") {
            continue;
        }

        providerStatuses.set(item.provider, true);
    }

    const healthy = Array.from(providerStatuses.values()).filter(Boolean).length;

    return {
        providerSummary,
        total,
        healthy,
        providers: Array.from(providers),
        uniqueProviders: providers.size,
    };
}

export function getProviderHealth(item: { count: number; error?: string }) {
    if (item.error) {
        return "error" as const;
    }

    if (item.count === 0) {
        return "warning" as const;
    }

    return "healthy" as const;
}

export function getMedianActivePricePerM2(data: DashboardExport): number {
    return median(data.listings.activeSales.map((listing) => listing.pricePerM2 ?? 0).filter((value) => value > 0));
}
