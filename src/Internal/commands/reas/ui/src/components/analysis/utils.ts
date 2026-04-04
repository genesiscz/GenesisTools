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

export function hasSoldComparableEvidence(data: DashboardExport): boolean {
    return data.analysis.comparables.count > 0 && data.analysis.comparables.median > 0;
}

export function getComparableNarrative(data: DashboardExport): string {
    if (!hasSoldComparableEvidence(data)) {
        return "Sold comparable evidence is currently unavailable for the selected horizon.";
    }

    return `The target sits at ${formatPercentile(data.analysis.comparables.targetPercentile)} of sold comparables.`;
}

export function getComparableGapSummary(data: DashboardExport): string {
    if (!hasSoldComparableEvidence(data)) {
        return "No sold comparable evidence returned";
    }

    const priceGap = getTargetPricePerM2(data) - data.analysis.comparables.median;

    if (priceGap === 0) {
        return "At the sold median";
    }

    const direction = priceGap > 0 ? "Above" : "Below";
    return `${direction} sold median by ${formatCompactCurrency(Math.abs(priceGap))}`;
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

    return {
        overall: 0,
        grade: "N/A",
        reasoning: ["Investment score was not included in this dashboard export."],
        recommendation: "Unavailable",
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
