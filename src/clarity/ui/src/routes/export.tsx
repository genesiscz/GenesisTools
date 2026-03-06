import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { Skeleton } from "@ui/components/skeleton";
import { ExportSummary } from "../components/ExportSummary";
import { ExportTable } from "../components/ExportTable";
import { MonthPicker } from "../components/MonthPicker";
import { useAppContext } from "../context/AppContext";

async function fetchExport(month: number, year: number) {
    const res = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month, year }),
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

export function ExportPage() {
    const { month, year, setMonthYear } = useAppContext();

    const {
        data: exportData,
        isLoading,
        error,
    } = useQuery({
        queryKey: ["export", month, year],
        queryFn: () => fetchExport(month, year),
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

    const mappedIds = new Set<number>(
        (mappingsData?.mappings ?? []).map((m: { adoWorkItemId: number }) => m.adoWorkItemId)
    );

    return (
        <div className="max-w-6xl mx-auto px-6 py-8">
            <div className="flex items-center justify-between mb-6">
                <h1 className="text-xl font-mono font-bold text-gray-200">
                    ADO TIMELOG <span className="text-amber-500">EXPORT</span>
                </h1>
                <MonthPicker month={month} year={year} onChange={setMonthYear} />
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
                                ENTRIES ({exportData.entries.length})
                            </CardTitle>
                        </CardHeader>
                        <CardContent>
                            <ExportTable
                                entries={exportData.entries}
                                entriesByDay={exportData.summary.entriesByDay}
                                mappedWorkItemIds={mappedIds}
                                adoOrg={adoConfig?.org}
                                adoProject={adoConfig?.project}
                            />
                        </CardContent>
                    </Card>
                </>
            )}
        </div>
    );
}
