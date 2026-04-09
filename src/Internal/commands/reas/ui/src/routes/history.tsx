import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { DistrictCommandSelect } from "@ui/components/command";
import { Skeleton } from "@ui/components/skeleton";
import { BarChart3, Clock, X } from "lucide-react";
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
    const [selectedDistrict, setSelectedDistrict] = useState("");
    const [chartType, setChartType] = useState("brick");

    const { data: historyData, isLoading: historyLoading } = useHistory(200);
    const { data: snapshotData, isLoading: snapshotsLoading } = useDistrictSnapshots(selectedDistrict, chartType);

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
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
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

            {/* District + Type selector toolbar */}
            <div className="flex flex-col sm:flex-row gap-3 mb-6">
                <div className="flex-1 max-w-xs">
                    <div className="block text-[10px] font-mono text-gray-500 mb-1 uppercase tracking-wider">
                        District
                    </div>
                    <div className="flex items-center gap-2">
                        <div className="flex-1">
                            <DistrictCommandSelect
                                value={selectedDistrict}
                                onValueChange={setSelectedDistrict}
                                placeholder="All districts..."
                                shouldFilter={false}
                            />
                        </div>
                        {selectedDistrict && (
                            <button
                                type="button"
                                onClick={() => setSelectedDistrict("")}
                                className="p-1.5 rounded text-gray-500 hover:text-gray-300 hover:bg-white/5 transition-colors"
                                title="Clear filter"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        )}
                    </div>
                </div>
                <div>
                    <label
                        htmlFor="history-construction"
                        className="block text-[10px] font-mono text-gray-500 mb-1 uppercase tracking-wider"
                    >
                        Construction
                    </label>
                    <select
                        id="history-construction"
                        value={chartType}
                        onChange={(e) => setChartType(e.target.value)}
                        className="cyber-select"
                    >
                        <option value="brick">Brick</option>
                        <option value="panel">Panel</option>
                        <option value="house">House</option>
                    </select>
                </div>
            </div>

            {/* Trend Chart Section */}
            <Card className="border-white/5 bg-white/[0.02] mb-6">
                <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-mono text-amber-400 flex items-center gap-2">
                        <BarChart3 className="w-4 h-4" />
                        Price Trend (CZK/m2)
                        {selectedDistrict && <span className="text-gray-500 font-normal">— {selectedDistrict}</span>}
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    {!selectedDistrict ? (
                        <div className="flex items-center justify-center h-[200px] border border-white/5 rounded-lg">
                            <p className="text-xs font-mono text-gray-500">
                                Select a district above to view price trends
                            </p>
                        </div>
                    ) : snapshotsLoading ? (
                        <Skeleton variant="default" className="h-[200px] w-full rounded-lg" />
                    ) : (
                        <TrendChart data={chartData} />
                    )}
                </CardContent>
            </Card>

            {/* History Table Section */}
            <Card className="border-white/5 bg-white/[0.02]">
                <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-mono text-amber-400 flex items-center gap-2">
                        <Clock className="w-4 h-4" />
                        Analysis History
                        {selectedDistrict && <span className="text-gray-500 font-normal">— {selectedDistrict}</span>}
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    {historyLoading ? (
                        <div className="space-y-2">
                            {["skel-1", "skel-2", "skel-3", "skel-4", "skel-5"].map((key) => (
                                <Skeleton key={key} variant="default" className="h-8 w-full" />
                            ))}
                        </div>
                    ) : (
                        <HistoryTable entries={entries} districtFilter={selectedDistrict} />
                    )}
                </CardContent>
            </Card>
        </div>
    );
}
