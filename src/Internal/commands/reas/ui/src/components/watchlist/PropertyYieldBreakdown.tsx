import type { PropertyCardModel } from "./property-card-model";
import { formatCurrencyFull, formatNumber, formatYield } from "./watchlist-utils";

export function PropertyYieldBreakdown({ model }: { model: PropertyCardModel }) {
    const financedCarry = model.yieldBreakdown.financedYield;
    const benchmarkMax = Math.max(
        model.yieldBreakdown.netYield ?? 0,
        model.yieldBreakdown.marketNetYield ?? 0,
        ...model.yieldBreakdown.benchmarks.map((benchmark) => benchmark.yield)
    );

    return (
        <div className="rounded-md border border-white/5 bg-black/20 px-3 py-3">
            <div className="text-[10px] font-mono uppercase tracking-wider text-gray-600">Yield Breakdown</div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] font-mono text-gray-300">
                <span>Gross {formatYield(model.yieldBreakdown.grossYield)}</span>
                <span>Net {formatYield(model.yieldBreakdown.netYield)}</span>
                <span>Market net {formatYield(model.yieldBreakdown.marketNetYield)}</span>
                <span>Payback {formatNumber(model.yieldBreakdown.paybackYears, 1)}y</span>
            </div>
            <div className="mt-3 text-[11px] font-mono text-gray-500">
                Market price {formatCurrencyFull(model.yieldBreakdown.marketPrice)}
            </div>

            {financedCarry != null && (
                <div className="mt-3 text-[11px] font-mono text-amber-300">
                    Financed carry {formatYield(financedCarry)}
                </div>
            )}

            {model.yieldBreakdown.benchmarks.length > 0 && (
                <div className="mt-3 space-y-2">
                    <div className="text-[10px] font-mono uppercase tracking-wider text-gray-600">Benchmarks</div>
                    {model.yieldBreakdown.benchmarks.map((benchmark) => (
                        <div key={benchmark.name} className="space-y-1">
                            <div className="flex items-center justify-between text-[10px] font-mono text-gray-400">
                                <span>{benchmark.name}</span>
                                <span>{formatYield(benchmark.yield)}</span>
                            </div>
                            <div className="h-1.5 overflow-hidden rounded-full bg-white/5">
                                <div
                                    className="h-full rounded-full bg-cyan-400/80"
                                    style={{
                                        width: `${Math.max(8, (benchmark.yield / Math.max(benchmarkMax, 1)) * 100)}%`,
                                    }}
                                />
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
