import type { DashboardExport } from "@app/Internal/commands/reas/lib/api-export";
import { ComparablesTable } from "./ComparablesTable";
import { MomentumCard } from "./MomentumCard";
import { PriceTrendChart } from "./PriceTrendChart";
import { ScoreCard } from "./ScoreCard";
import { StalenessIndicator } from "./StalenessIndicator";
import { YieldCard } from "./YieldCard";

interface AnalysisResultsProps {
    data: DashboardExport;
}

export function AnalysisResults({ data }: AnalysisResultsProps) {
    return (
        <div className="space-y-4 animate-slide-up">
            {/* Header with staleness */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <h2 className="text-sm font-mono font-bold text-gray-200">
                        Results for <span className="text-amber-400">{data.meta.target.district}</span>
                    </h2>
                    <StalenessIndicator generatedAt={data.meta.generatedAt} />
                </div>
                <span className="text-[10px] font-mono text-gray-600">
                    {data.meta.target.constructionType} &middot; {data.meta.target.disposition}
                </span>
            </div>

            {/* Score + Yield row */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <ScoreCard data={data} />
                <YieldCard data={data} />
            </div>

            {/* Chart full width */}
            <PriceTrendChart data={data} />

            {/* Momentum full width */}
            <MomentumCard data={data} />

            {/* Comparables table full width */}
            <ComparablesTable data={data} />
        </div>
    );
}
