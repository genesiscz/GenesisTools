import type { SavedPropertyRow } from "@app/Internal/commands/reas/lib/store";
import type { FullAnalysis } from "@app/Internal/commands/reas/types";
import { SafeJSON } from "@app/utils/json";

export interface PropertyMetricChip {
    label: string;
    value: string;
    tone: "default" | "accent" | "success" | "warning" | "danger";
}

export interface PropertyYieldBreakdownModel {
    grossYield: number | null;
    netYield: number | null;
    paybackYears: number | null;
    marketNetYield: number | null;
    marketGrossYield: number | null;
    marketPrice: number | null;
    targetPrice: number;
    financedYield: number | null;
    benchmarks: Array<{ name: string; yield: number }>;
}

export interface PropertyMortgageModel {
    monthlyPayment: number;
    totalInterest: number;
    monthlyCashflow: number;
    ltv: number;
    cashOnCashReturn: number;
    breakEvenOccupancy: number;
    amortization: number[];
}

export interface PropertyCardModel {
    recommendation: string | null;
    reasons: string[];
    verdictChecklist: Array<{ label: string; passed: boolean }>;
    metrics: PropertyMetricChip[];
    yieldBreakdown: PropertyYieldBreakdownModel;
    mortgage: PropertyMortgageModel | null;
}

export function buildPropertyCardModel(property: SavedPropertyRow): PropertyCardModel | null {
    if (!property.last_analysis_json) {
        return null;
    }

    const analysis = SafeJSON.parse(property.last_analysis_json) as FullAnalysis;
    const percentile = analysis.comparables.targetPercentile ?? property.percentile ?? null;
    const comparablesCount = analysis.comparables.listings.length || property.comparable_count || 0;
    const medianPrice =
        comparablesCount > 0
            ? analysis.comparables.pricePerM2.median || property.last_median_price_per_m2 || null
            : null;
    const momentumDirection = analysis.momentum?.direction ?? property.momentum ?? null;
    const netYield = analysis.yield.netYield ?? property.last_net_yield ?? null;
    const mortgageModel = buildMortgageModel(property);

    return {
        recommendation: analysis.investmentScore?.recommendation ?? null,
        reasons: (analysis.investmentScore?.reasoning ?? []).slice(0, 3),
        verdictChecklist: [
            { label: "Yield >= 3.5%", passed: (netYield ?? 0) >= 3.5 },
            { label: "Percentile <= 50th", passed: (percentile ?? 100) <= 50 },
            { label: "At least 5 comps", passed: comparablesCount >= 5 },
            { label: "Rising momentum", passed: momentumDirection === "rising" },
            { label: "Discount present", passed: (property.discount_vs_market ?? 0) < 0 },
            { label: "Payback under 30y", passed: (analysis.yield.paybackYears ?? 999) < 30 },
        ],
        metrics: [
            {
                label: "Grade",
                value: property.last_grade ?? "-",
                tone: gradeTone(property.last_grade),
            },
            {
                label: "Net Yield",
                value: formatPercentMetric(netYield, 1),
                tone: yieldTone(netYield),
            },
            {
                label: "Percentile",
                value: percentile == null ? "-" : `${percentile.toFixed(0)}th`,
                tone: percentileTone(percentile),
            },
            {
                label: "CZK/m2",
                value: formatNumberMetric(medianPrice),
                tone: "default",
            },
            {
                label: "Comps",
                value: comparablesCount > 0 ? String(comparablesCount) : "-",
                tone: comparablesCount >= 5 ? "success" : comparablesCount > 0 ? "warning" : "danger",
            },
            {
                label: "Momentum",
                value: momentumDirection ?? "-",
                tone: momentumTone(momentumDirection),
            },
        ],
        yieldBreakdown: {
            grossYield: finiteOrNull(analysis.yield.grossYield),
            netYield: finiteOrNull(netYield),
            paybackYears: finiteOrNull(analysis.yield.paybackYears),
            marketNetYield: finiteOrNull(analysis.yield.atMarketPrice.netYield),
            marketGrossYield: finiteOrNull(analysis.yield.atMarketPrice.grossYield),
            marketPrice: finiteOrNull(analysis.yield.atMarketPrice.price),
            targetPrice: property.target_price,
            financedYield:
                property.target_price > 0 && property.monthly_rent > 0
                    ? ((property.monthly_rent - property.monthly_costs - (mortgageModel?.monthlyPayment ?? 0)) *
                          12 *
                          100) /
                      property.target_price
                    : null,
            benchmarks: analysis.yield.benchmarks ?? [],
        },
        mortgage: mortgageModel,
    };
}

function buildMortgageModel(property: SavedPropertyRow): PropertyMortgageModel | null {
    if (
        !property.loan_amount ||
        !property.mortgage_rate ||
        !property.mortgage_term ||
        !property.target_price ||
        property.loan_amount <= 0 ||
        property.mortgage_term <= 0
    ) {
        return null;
    }

    const monthlyRate = property.mortgage_rate / 100 / 12;
    const numberOfPayments = property.mortgage_term * 12;
    const monthlyPayment =
        monthlyRate === 0
            ? property.loan_amount / numberOfPayments
            : (property.loan_amount * monthlyRate) / (1 - (1 + monthlyRate) ** -numberOfPayments);
    const totalInterest = monthlyPayment * numberOfPayments - property.loan_amount;
    const equity =
        property.down_payment && property.down_payment > 0
            ? property.down_payment
            : property.target_price - property.loan_amount;
    const annualCashflow = (property.monthly_rent - property.monthly_costs - monthlyPayment) * 12;
    const breakEvenOccupancy =
        property.monthly_rent > 0 ? ((monthlyPayment + property.monthly_costs) / property.monthly_rent) * 100 : 0;

    return {
        monthlyPayment,
        totalInterest,
        monthlyCashflow: property.monthly_rent - property.monthly_costs - monthlyPayment,
        ltv: (property.loan_amount / property.target_price) * 100,
        cashOnCashReturn: equity > 0 ? (annualCashflow / equity) * 100 : 0,
        breakEvenOccupancy,
        amortization: buildAmortizationSeries({
            principal: property.loan_amount,
            monthlyRate,
            monthlyPayment,
            years: Math.min(property.mortgage_term, 6),
        }),
    };
}

function buildAmortizationSeries(options: {
    principal: number;
    monthlyRate: number;
    monthlyPayment: number;
    years: number;
}): number[] {
    let balance = options.principal;
    const series = [balance];

    for (let year = 0; year < options.years - 1; year++) {
        for (let month = 0; month < 12; month++) {
            const interest = balance * options.monthlyRate;
            const principalPaid = options.monthlyPayment - interest;
            balance = Math.max(0, balance - principalPaid);
        }

        series.push(balance);
    }

    return series;
}

function finiteOrNull(value: number | null | undefined): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatPercentMetric(value: number | null | undefined, digits = 1): string {
    return value == null ? "-" : `${value.toFixed(digits)}%`;
}

function formatNumberMetric(value: number | null | undefined): string {
    return value == null ? "-" : Math.round(value).toLocaleString("cs-CZ");
}

function gradeTone(grade: string | null): PropertyMetricChip["tone"] {
    if (grade === "A" || grade === "B") {
        return "success";
    }

    if (grade === "C") {
        return "warning";
    }

    if (grade === "D" || grade === "F") {
        return "danger";
    }

    return "default";
}

function yieldTone(value: number | null): PropertyMetricChip["tone"] {
    if (value == null) {
        return "default";
    }

    if (value >= 5) {
        return "success";
    }

    if (value >= 3.5) {
        return "warning";
    }

    return "danger";
}

function percentileTone(value: number | null): PropertyMetricChip["tone"] {
    if (value == null) {
        return "default";
    }

    if (value <= 35) {
        return "success";
    }

    if (value <= 65) {
        return "warning";
    }

    return "danger";
}

function momentumTone(value: string | null): PropertyMetricChip["tone"] {
    if (value === "rising") {
        return "success";
    }

    if (value === "stable") {
        return "warning";
    }

    if (value === "declining") {
        return "danger";
    }

    return "default";
}
