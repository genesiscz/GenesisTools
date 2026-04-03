import type { PropertyMortgageModel } from "./property-card-model";
import { formatCurrencyCompact, formatCurrencyFull, formatPercent, formatYield } from "./watchlist-utils";

export function PropertyMortgageCard({ mortgage }: { mortgage: PropertyMortgageModel | null }) {
    return (
        <div className="rounded-md border border-white/5 bg-black/20 px-3 py-3">
            <div className="text-[10px] font-mono uppercase tracking-wider text-gray-600">Mortgage</div>
            {mortgage ? (
                <>
                    <div className="mt-3 space-y-2 text-[11px] font-mono text-gray-300">
                        <div>Payment {formatCurrencyFull(mortgage.monthlyPayment)}</div>
                        <div>Cashflow {formatCurrencyFull(mortgage.monthlyCashflow)}</div>
                        <div>Total interest {formatCurrencyCompact(mortgage.totalInterest)}</div>
                        <div>LTV {formatPercent(mortgage.ltv)}</div>
                        <div>CoC {formatYield(mortgage.cashOnCashReturn)}</div>
                        <div>Break-even {formatPercent(mortgage.breakEvenOccupancy)}</div>
                    </div>
                    <div className="mt-3">
                        <div className="mb-1 text-[10px] font-mono uppercase tracking-wider text-gray-600">Balance</div>
                        <svg viewBox="0 0 100 24" className="h-6 w-full overflow-visible" aria-hidden="true">
                            <polyline
                                fill="none"
                                stroke="rgb(251 191 36)"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                points={buildBalancePoints(mortgage.amortization).join(" ")}
                            />
                        </svg>
                    </div>
                </>
            ) : (
                <div className="mt-3 text-[11px] font-mono text-gray-500">
                    Add mortgage inputs to surface financing impact.
                </div>
            )}
        </div>
    );
}

function buildBalancePoints(values: number[]): string[] {
    if (values.length < 2) {
        return [];
    }

    const min = Math.min(...values);
    const max = Math.max(...values);

    return values.map((value, index) => {
        const x = (index / (values.length - 1)) * 100;
        const y = max === min ? 12 : 24 - ((value - min) / (max - min)) * 24;
        return `${x.toFixed(2)},${y.toFixed(2)}`;
    });
}
