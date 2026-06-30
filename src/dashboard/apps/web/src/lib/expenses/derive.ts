import { categoryStyle } from "./categories";
import type { ExpenseRow } from "./expenses.server";
import { monthOf } from "./money";

export type CategoryBucket = {
    category: string;
    label: string;
    color: string;
    totalCents: number;
    count: number;
    /** Share of the month total, 0–100. */
    percentage: number;
};

export interface MonthSummary {
    monthExpenses: ExpenseRow[];
    totalCents: number;
    count: number;
    buckets: CategoryBucket[];
    /** Display currency for the month (most common; falls back to USD). */
    currency: string;
}

/** Sorted set of "YYYY-MM" keys that have at least one expense, newest first. */
export function monthsWithData(expenses: ExpenseRow[]): string[] {
    const set = new Set<string>();
    for (const e of expenses) {
        set.add(monthOf(e.day));
    }
    return Array.from(set).sort().reverse();
}

export function summarizeMonth(expenses: ExpenseRow[], monthKey: string): MonthSummary {
    const monthExpenses = expenses.filter((e) => monthOf(e.day) === monthKey);

    let totalCents = 0;
    const byCategory = new Map<string, { totalCents: number; count: number }>();
    const currencyCounts = new Map<string, number>();

    for (const e of monthExpenses) {
        totalCents += e.amountCents;

        const existing = byCategory.get(e.category) ?? { totalCents: 0, count: 0 };
        existing.totalCents += e.amountCents;
        existing.count += 1;
        byCategory.set(e.category, existing);

        currencyCounts.set(e.currency, (currencyCounts.get(e.currency) ?? 0) + 1);
    }

    const buckets: CategoryBucket[] = Array.from(byCategory.entries())
        .map(([category, agg]) => {
            const style = categoryStyle(category);
            return {
                category,
                label: style.label,
                color: style.color,
                totalCents: agg.totalCents,
                count: agg.count,
                percentage: totalCents > 0 ? (agg.totalCents / totalCents) * 100 : 0,
            };
        })
        .sort((a, b) => b.totalCents - a.totalCents);

    let currency = "USD";
    let topCount = 0;
    for (const [code, n] of currencyCounts) {
        if (n > topCount) {
            topCount = n;
            currency = code;
        }
    }

    return {
        monthExpenses,
        totalCents,
        count: monthExpenses.length,
        buckets,
        currency,
    };
}
