import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { Skeleton } from "@ui/components/skeleton";
import { BarChart3, Clock } from "lucide-react";
import { useMemo, useState } from "react";
import { HistoryTable } from "../components/history/HistoryTable";
import { TrendChart } from "../components/history/TrendChart";

export const Route = createFileRoute("/history")({
    component: HistoryPage,
});

interface HistoryEntry {
    id: number;
    district: string;
    constructionType: string;
    disposition: string | null;
    targetPrice: number;
    targetArea: number;
    medianPricePerM2: number | null;
    investmentScore: number | null;
    investmentGrade: string | null;
    netYield: number | null;
    grossYield: number | null;
    medianDaysOnMarket: number | null;
    medianDiscount: number | null;
    comparablesCount: number | null;
    createdAt: string;
}

interface HistoryResponse {
    history: HistoryEntry[];
}

interface DistrictsResponse {
    districts: string[];
    praha: string[];
}

interface SnapshotEntry {
    district: string;
    medianPricePerM2: number;
    snapshotDate: string;
}

interface SnapshotResponse {
    snapshots: SnapshotEntry[];
}

function useHistory(limit: number) {
    return useQuery<HistoryResponse>({
        queryKey: ["history", limit],
        queryFn: async () => {
            const res = await fetch(`/api/history?limit=${limit}`);

            if (!res.ok) {
                throw new Error("Failed to fetch history");
            }

            return res.json();
        },
    });
}

function useDistricts() {
    return useQuery<DistrictsResponse>({
        queryKey: ["districts"],
        queryFn: async () => {
            const res = await fetch("/api/districts");

            if (!res.ok) {
                throw new Error("Failed to fetch districts");
            }

            return res.json();
        },
        staleTime: 60_000 * 10,
    });
}

function useDistrictSnapshots(district: string, type: string) {
    return useQuery<SnapshotResponse>({
        queryKey: ["district-snapshots", district, type],
        queryFn: async () => {
            const params = new URLSearchParams({ district, type });
            const res = await fetch(`/api/district-snapshots?${params.toString()}`);

            if (!res.ok) {
                throw new Error("Failed to fetch snapshots");
            }

            return res.json();
        },
        enabled: !!district,
    });
}

function HistoryPage() {
    const [districtFilter, setDistrictFilter] = useState("");
    const [chartDistrict, setChartDistrict] = useState("");
    const [chartType, setChartType] = useState("brick");

    const { data: historyData, isLoading: historyLoading } = useHistory(200);
    const { data: districtsData } = useDistricts();
    const { data: snapshotData, isLoading: snapshotsLoading } = useDistrictSnapshots(chartDistrict, chartType);

    const allDistricts = districtsData
        ? [...districtsData.praha, ...districtsData.districts.filter((d) => !districtsData.praha.includes(d))]
        : [];

    const uniqueHistoryDistricts = useMemo(() => {
        if (!historyData?.history) {
            return [];
        }

        return [...new Set(historyData.history.map((h) => h.district))].sort();
    }, [historyData]);

    const chartData = useMemo(() => {
        if (!snapshotData?.snapshots) {
            return [];
        }

        return snapshotData.snapshots.map((s) => ({
            date: s.snapshotDate,
            value: s.medianPricePerM2,
            district: s.district,
        }));
    }, [snapshotData]);

    const entries = historyData?.history ?? [];

    return (
        <div className="max-w-6xl mx-auto px-6 py-8">
            {/* Header */}
            <div className="flex items-center gap-3 mb-6">
                <div className="p-2 rounded bg-amber-500/10 border border-amber-500/30">
                    <Clock className="w-5 h-5 text-amber-400" />
                </div>
                <div>
                    <h1 className="text-xl font-mono font-bold text-gray-200">History</h1>
                    <p className="text-xs text-gray-500 font-mono">Browse past analysis results and snapshots</p>
                </div>
            </div>

            {/* Trend Chart Section */}
            <Card className="border-white/5 bg-white/[0.02] mb-6">
                <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                        <CardTitle className="text-sm font-mono text-amber-400 flex items-center gap-2">
                            <BarChart3 className="w-4 h-4" />
                            Price Trend (CZK/m2)
                        </CardTitle>
                        <div className="flex items-center gap-2">
                            <label htmlFor="chart-district">
                                <span className="sr-only">Chart district</span>
                                <select
                                    id="chart-district"
                                    value={chartDistrict}
                                    onChange={(e) => setChartDistrict(e.target.value)}
                                    className="h-7 rounded bg-black/20 border border-white/10 text-xs font-mono text-gray-300 px-2"
                                >
                                    <option value="">Select district...</option>
                                    {allDistricts.map((d) => (
                                        <option key={d} value={d}>
                                            {d}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            <label htmlFor="chart-type">
                                <span className="sr-only">Construction type</span>
                                <select
                                    id="chart-type"
                                    value={chartType}
                                    onChange={(e) => setChartType(e.target.value)}
                                    className="h-7 rounded bg-black/20 border border-white/10 text-xs font-mono text-gray-300 px-2"
                                >
                                    <option value="brick">Brick</option>
                                    <option value="panel">Panel</option>
                                    <option value="house">House</option>
                                </select>
                            </label>
                        </div>
                    </div>
                </CardHeader>
                <CardContent>
                    {!chartDistrict ? (
                        <div className="flex items-center justify-center h-[200px] border border-white/5 rounded-lg">
                            <p className="text-xs font-mono text-gray-500">Select a district to view price trends</p>
                        </div>
                    ) : snapshotsLoading ? (
                        <Skeleton variant="chart" className="h-[200px] w-full" />
                    ) : (
                        <TrendChart data={chartData} />
                    )}
                </CardContent>
            </Card>

            {/* History Table Section */}
            <Card className="border-white/5 bg-white/[0.02]">
                <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                        <CardTitle className="text-sm font-mono text-amber-400 flex items-center gap-2">
                            <Clock className="w-4 h-4" />
                            Analysis History
                        </CardTitle>
                        <label htmlFor="table-district">
                            <span className="sr-only">Filter by district</span>
                            <select
                                id="table-district"
                                value={districtFilter}
                                onChange={(e) => setDistrictFilter(e.target.value)}
                                className="h-7 rounded bg-black/20 border border-white/10 text-xs font-mono text-gray-300 px-2"
                            >
                                <option value="">All districts</option>
                                {uniqueHistoryDistricts.map((d) => (
                                    <option key={d} value={d}>
                                        {d}
                                    </option>
                                ))}
                            </select>
                        </label>
                    </div>
                </CardHeader>
                <CardContent>
                    {historyLoading ? (
                        <div className="space-y-2">
                            {["skel-1", "skel-2", "skel-3", "skel-4", "skel-5"].map((key) => (
                                <Skeleton key={key} variant="text" className="h-8 w-full" />
                            ))}
                        </div>
                    ) : (
                        <HistoryTable entries={entries} districtFilter={districtFilter} />
                    )}
                </CardContent>
            </Card>
        </div>
    );
}
