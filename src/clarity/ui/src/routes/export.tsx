import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { Skeleton } from "@ui/components/skeleton";
import { RefreshCw } from "lucide-react";
import { useRef } from "react";
import { ExportSummary } from "../components/ExportSummary";
import { ExportTable } from "../components/ExportTable";
import { MonthPicker } from "../components/MonthPicker";
import { useAppContext } from "../context/AppContext";

async function fetchExport(month: number, year: number, force = false) {
    const res = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month, year, force }),
    });

    if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || `Export failed (${res.status})`);
    }

    return res.json();
}

async function fetchMappings() {
    const res = await fetch("/api/mappings");

    if (!res.ok) {
        return { mappings: [] };
    }

    return res.json();
}

export const Route = createFileRoute("/export")({
    component: ExportPage,
});

function ExportPage() {
    const { month, year, setMonthYear } = useAppContext();
    const queryClient = useQueryClient();
    const forceRef = useRef(false);

    const {
        data: exportData,
        isLoading,
        error,
    } = useQuery({
        queryKey: ["export", month, year],
        queryFn: () => {
            const force = forceRef.current;
            forceRef.current = false;
            return fetchExport(month, year, force);
        },
    });

    const { data: mappingsData } = useQuery({
        queryKey: ["mappings"],
        queryFn: fetchMappings,
    });

    const { data: adoConfig } = useQuery({
        queryKey: ["ado-config"],
        queryFn: async () => {
            const res = await fetch("/api/ado-config");
            return res.ok ? res.json() : { configured: false };
        },
    });

    const { data: typeColorsData } = useQuery({
        queryKey: ["workitem-type-colors"],
        queryFn: async () => {
            const res = await fetch("/api/workitem-type-colors");
            if (!res.ok) {
                return { types: {} };
            }

            return res.json();
        },
    });

    const mappedIds = new Set<number>(
        (mappingsData?.mappings ?? []).map((m: { adoWorkItemId: number }) => m.adoWorkItemId)
    );

    return (
        <div className="max-w-6xl mx-auto px-6 py-8">
            <div className="flex items-center justify-between mb-6">
                <h1 className="text-xl font-mono font-bold text-gray-200">
                    ADO Timelog <span className="text-amber-500">Export</span>
                </h1>
                <div className="flex items-center gap-2">
                    <MonthPicker month={month} year={year} onChange={setMonthYear} />
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                            forceRef.current = true;
                            queryClient.invalidateQueries({ queryKey: ["export", month, year] });
                            queryClient.invalidateQueries({ queryKey: ["workitem-type-colors"] });
                        }}
                        className="font-mono text-xs"
                    >
                        <RefreshCw className="w-3.5 h-3.5" />
                    </Button>
                </div>
            </div>

            {isLoading && (
                <div className="space-y-4">
                    <div className="grid grid-cols-4 gap-3">
                        {["s-hours", "s-entries", "s-items", "s-days"].map((id) => (
                            <Skeleton key={id} variant="card" />
                        ))}
                    </div>
                    <Skeleton variant="card" />
                </div>
            )}

            {error && (
                <Card className="border-red-500/20">
                    <CardContent className="p-6">
                        <div className="text-red-400 font-mono text-sm">
                            {error instanceof Error ? error.message : "Failed to load export data"}
                        </div>
                    </CardContent>
                </Card>
            )}

            {exportData && (
                <>
                    <div className="mb-6">
                        <ExportSummary
                            totalHours={exportData.summary.totalHours}
                            totalEntries={exportData.entries.length}
                            workItemCount={Object.keys(exportData.summary.entriesByWorkItem).length}
                            dayCount={Object.keys(exportData.summary.entriesByDay).length}
                        />
                    </div>

                    <Card className="border-amber-500/20">
                        <CardHeader className="pb-3">
                            <CardTitle className="text-sm font-mono text-gray-400">
                                Entries ({exportData.entries.length})
                            </CardTitle>
                        </CardHeader>
                        <CardContent>
                            <ExportTable
                                entries={exportData.entries}
                                entriesByDay={exportData.summary.entriesByDay}
                                mappedWorkItemIds={mappedIds}
                                adoConfig={adoConfig?.org ? (adoConfig as { org: string; project: string }) : null}
                                typeColors={typeColorsData?.types ?? {}}
                            />
                        </CardContent>
                    </Card>
                </>
            )}
        </div>
    );
}
