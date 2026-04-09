import type { TimesheetWeek } from "@app/clarity/lib/timesheet-weeks";
import type { ClarityTask } from "@app/clarity/lib/types";
import { SafeJSON } from "@app/utils/json";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Badge } from "@ui/components/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@ui/components/dialog";
import { Skeleton } from "@ui/components/skeleton";
import { useState } from "react";
import { toast } from "sonner";
import { AddMappingForm } from "../components/AddMappingForm";
import type { ClarityGroup } from "../components/MappingTable";
import { MappingTable } from "../components/MappingTable";
import { MonthPicker } from "../components/MonthPicker";
import { WorkItemSelector } from "../components/WorkItemSelector";
import { useAppContext } from "../context/AppContext";

async function fetchMappings() {
    const res = await fetch("/api/mappings");

    if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || `Failed to fetch mappings (${res.status})`);
    }

    return res.json();
}

async function fetchTypeColors(): Promise<{
    types: Record<string, { color: string; name: string; icon: { id: string; url: string } }>;
}> {
    const res = await fetch("/api/workitem-type-colors");

    if (!res.ok) {
        return { types: {} };
    }

    return res.json();
}

async function fetchAdoConfig(): Promise<{ org: string | null; project: string | null }> {
    const res = await fetch("/api/ado-config");

    if (!res.ok) {
        return { org: null, project: null };
    }

    return res.json();
}

async function fetchWeeks(month: number, year: number): Promise<{ weeks: TimesheetWeek[] }> {
    const res = await fetch("/api/clarity-weeks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: SafeJSON.stringify({ month, year }),
    });

    if (!res.ok) {
        return { weeks: [] };
    }

    return res.json();
}

async function fetchClarityTasks(timesheetId: number): Promise<{ tasks: ClarityTask[] }> {
    const res = await fetch("/api/clarity-tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: SafeJSON.stringify({ timesheetId }),
    });

    if (!res.ok) {
        return { tasks: [] };
    }

    return res.json();
}

async function deleteMappingApi(adoWorkItemId: number) {
    const res = await fetch("/api/mappings", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: SafeJSON.stringify({ adoWorkItemId }),
    });

    if (!res.ok) {
        throw new Error("Failed to remove mapping");
    }

    return res.json();
}

async function moveMappingApi(
    adoWorkItemId: number,
    target: {
        clarityTaskId: number;
        clarityTaskName: string;
        clarityTaskCode: string;
        clarityInvestmentName: string;
        clarityInvestmentCode: string;
    }
) {
    const res = await fetch("/api/move-mapping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: SafeJSON.stringify({ adoWorkItemId, target }),
    });

    if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || "Failed to move mapping");
    }

    return res.json();
}

export const Route = createFileRoute("/mappings")({
    component: MappingsPage,
});

function MappingsPage() {
    const queryClient = useQueryClient();
    const { month, year, setMonthYear } = useAppContext();
    const [addToTask, setAddToTask] = useState<ClarityGroup | null>(null);

    const { data, isLoading, error } = useQuery({
        queryKey: ["mappings"],
        queryFn: fetchMappings,
    });

    const { data: typeColors } = useQuery({
        queryKey: ["workitem-type-colors"],
        queryFn: fetchTypeColors,
        staleTime: 60 * 60 * 1000,
    });

    const { data: adoConfigRaw } = useQuery({
        queryKey: ["ado-config"],
        queryFn: fetchAdoConfig,
        staleTime: 60 * 60 * 1000,
    });

    const adoConfig =
        adoConfigRaw?.org && adoConfigRaw?.project ? { org: adoConfigRaw.org, project: adoConfigRaw.project } : null;

    const { data: weeksData } = useQuery({
        queryKey: ["clarity-weeks", month, year],
        queryFn: () => fetchWeeks(month, year),
    });

    const firstTimesheetId = weeksData?.weeks[0]?.timesheetId;

    const { data: tasksData } = useQuery({
        queryKey: ["clarity-tasks", firstTimesheetId],
        queryFn: () => fetchClarityTasks(firstTimesheetId!),
        enabled: !!firstTimesheetId,
    });

    const removeMutation = useMutation({
        mutationFn: deleteMappingApi,
        onSuccess: (_data, adoWorkItemId) => {
            toast.success(`Mapping removed for #${adoWorkItemId}`);
            queryClient.invalidateQueries({ queryKey: ["mappings"] });
        },
        onError: (err) => {
            toast.error(err instanceof Error ? err.message : "Failed to remove mapping");
        },
    });

    const moveMutation = useMutation({
        mutationFn: ({
            adoWorkItemId,
            target,
        }: {
            adoWorkItemId: number;
            target: Parameters<typeof moveMappingApi>[1];
        }) => moveMappingApi(adoWorkItemId, target),
        onSuccess: () => {
            toast.success("Mapping moved successfully");
            queryClient.invalidateQueries({ queryKey: ["mappings"] });
        },
        onError: (err) => {
            toast.error(err instanceof Error ? err.message : "Failed to move mapping");
        },
    });

    return (
        <div className="max-w-6xl mx-auto px-6 py-8">
            <div className="flex items-center justify-between mb-6">
                <h1 className="text-xl font-mono font-bold text-gray-200">
                    Work Item <span className="text-primary">&harr;</span> Clarity Mappings
                </h1>
                <div className="flex items-center gap-3">
                    {data?.mappings && (
                        <Badge variant="outline" className="font-mono">
                            {data.mappings.length} mappings
                        </Badge>
                    )}
                    <MonthPicker month={month} year={year} onChange={setMonthYear} />
                </div>
            </div>

            {/* Add Mapping — quick action on top */}
            <div className="mb-6">
                <AddMappingForm onMappingAdded={() => queryClient.invalidateQueries({ queryKey: ["mappings"] })} />
            </div>

            {/* Configured Mappings — main view below */}
            <Card className="border-primary/20">
                <CardHeader className="pb-3">
                    <CardTitle className="text-sm font-mono text-gray-400 flex items-center gap-2">
                        Configured Mappings
                        {!data?.configured && !isLoading && (
                            <Badge variant="destructive" className="text-xs">
                                Not Configured
                            </Badge>
                        )}
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    {isLoading && (
                        <div className="space-y-3">
                            <Skeleton variant="line" />
                            <Skeleton variant="line" />
                            <Skeleton variant="line" />
                        </div>
                    )}

                    {error && (
                        <div className="text-red-400 font-mono text-sm">
                            Error: {error instanceof Error ? error.message : "Unknown error"}
                        </div>
                    )}

                    {data && (
                        <MappingTable
                            mappings={data.mappings}
                            allTasks={tasksData?.tasks ?? []}
                            typeColors={typeColors?.types ?? {}}
                            adoConfig={adoConfig}
                            onRemove={(id) => removeMutation.mutate(id)}
                            onMove={(adoWorkItemId, target) => moveMutation.mutate({ adoWorkItemId, target })}
                            onAdd={setAddToTask}
                        />
                    )}
                </CardContent>
            </Card>

            {/* Add Work Items Dialog */}
            <Dialog open={!!addToTask} onOpenChange={(open: boolean) => !open && setAddToTask(null)}>
                <DialogContent className="sm:max-w-3xl max-h-[85vh] overflow-y-auto bg-gray-950 border-primary/20">
                    <DialogHeader>
                        <DialogTitle className="font-mono text-sm text-gray-200">
                            Add work items to <span className="text-primary">{addToTask?.clarityTaskName}</span>
                        </DialogTitle>
                        <DialogDescription className="font-mono text-xs text-gray-500">
                            {addToTask?.clarityTaskCode}
                            {addToTask?.clarityInvestmentName && ` · ${addToTask.clarityInvestmentName}`}
                        </DialogDescription>
                    </DialogHeader>
                    {addToTask && (
                        <WorkItemSelector
                            clarityTask={{
                                taskId: addToTask.clarityTaskId,
                                taskName: addToTask.clarityTaskName,
                                taskCode: addToTask.clarityTaskCode,
                                investmentName: addToTask.clarityInvestmentName,
                                investmentCode: addToTask.clarityInvestmentCode,
                            }}
                            timesheetId={firstTimesheetId}
                            month={month}
                            year={year}
                            onItemsAdded={() => {
                                setAddToTask(null);
                                queryClient.invalidateQueries({ queryKey: ["mappings"] });
                            }}
                        />
                    )}
                </DialogContent>
            </Dialog>
        </div>
    );
}
