import type { DashboardExport } from "@app/Internal/commands/reas/lib/api-export";
import { Link } from "@tanstack/react-router";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import { cn } from "@ui/lib/utils";
import { GitCompare } from "lucide-react";
import {
    ComparablesTab,
    InvestmentTab,
    OverviewTab,
    PriceDistributionTab,
    RentalsTab,
    TrendTab,
    VerdictTab,
} from "./analysis/AnalysisSections";
import { buildAnalysisCompareQuery } from "./compare/compare-query";
import { ExportButton } from "./ExportButton";
import { StalenessIndicator } from "./StalenessIndicator";

interface AnalysisResultsProps {
    data: DashboardExport;
}

const ANALYSIS_TABS = [
    { value: "overview", label: "Overview" },
    { value: "price-distribution", label: "Price Distribution" },
    { value: "trend", label: "Trend" },
    { value: "comparables", label: "Comparables" },
    { value: "rentals", label: "Rentals" },
    { value: "investment", label: "Investment" },
    { value: "verdict", label: "Verdict" },
] as const;

export function AnalysisResults({ data }: AnalysisResultsProps) {
    const compareHref = `/compare?${buildAnalysisCompareQuery(data).toString()}`;

    return (
        <div className="space-y-4 animate-slide-up">
            <div className="flex flex-col gap-4 rounded-2xl border border-white/5 bg-white/[0.02] p-4 sm:p-5">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                    <div className="space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                            <Badge className="border-amber-500/20 bg-amber-500/10 font-mono text-[10px] uppercase tracking-[0.24em] text-amber-200">
                                Analyze
                            </Badge>
                            <StalenessIndicator generatedAt={data.meta.generatedAt} />
                        </div>
                        <h2 className="text-lg font-semibold tracking-tight text-gray-100">
                            Results for <span className="text-amber-300">{data.meta.target.district}</span>
                        </h2>
                        <p className="text-xs font-mono text-slate-500">
                            {data.meta.target.constructionType} · {data.meta.target.disposition} ·{" "}
                            {data.analysis.comparables.count} sold comps · {data.listings.rentals.length} rentals
                        </p>
                    </div>
                    <div className="flex items-center gap-3">
                        <div className="hidden text-right sm:block">
                            <div className="text-[10px] font-mono uppercase tracking-[0.24em] text-slate-500">
                                Providers
                            </div>
                            <div className="text-xs font-mono text-slate-300">
                                {(data.meta.providers ?? []).join(" · ")}
                            </div>
                        </div>
                        <Button
                            asChild
                            variant="outline"
                            className="border-cyan-500/20 bg-cyan-500/5 text-cyan-300 hover:bg-cyan-500/10"
                        >
                            <Link to={compareHref}>
                                <GitCompare className="h-3.5 w-3.5" />
                                Compare District
                            </Link>
                        </Button>
                        <ExportButton data={data} />
                    </div>
                </div>
            </div>

            <Tabs defaultValue="overview" className="space-y-4">
                <TabsList className="flex h-auto w-full flex-wrap justify-start gap-2 rounded-2xl border border-white/5 bg-white/[0.02] p-2">
                    {ANALYSIS_TABS.map((tab) => (
                        <TabsTrigger
                            key={tab.value}
                            value={tab.value}
                            className={cn(
                                "rounded-xl px-3 py-2 font-mono text-[11px] uppercase tracking-[0.18em]",
                                "data-[state=active]:bg-amber-500/15 data-[state=active]:text-amber-200 data-[state=active]:shadow-none"
                            )}
                        >
                            {tab.label}
                        </TabsTrigger>
                    ))}
                </TabsList>

                <TabsContent value="overview">
                    <OverviewTab data={data} />
                </TabsContent>

                <TabsContent value="price-distribution">
                    <PriceDistributionTab data={data} />
                </TabsContent>

                <TabsContent value="trend">
                    <TrendTab data={data} />
                </TabsContent>

                <TabsContent value="comparables">
                    <ComparablesTab data={data} />
                </TabsContent>

                <TabsContent value="rentals">
                    <RentalsTab data={data} />
                </TabsContent>

                <TabsContent value="investment">
                    <InvestmentTab data={data} />
                </TabsContent>

                <TabsContent value="verdict">
                    <VerdictTab data={data} />
                </TabsContent>
            </Tabs>
        </div>
    );
}
