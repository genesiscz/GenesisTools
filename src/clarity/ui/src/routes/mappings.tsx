import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { Skeleton } from "@ui/components/skeleton";
import { toast } from "sonner";
import { AddMappingForm } from "../components/AddMappingForm";
import { MappingTable } from "../components/MappingTable";
import { MonthPicker } from "../components/MonthPicker";
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

async function deleteMappingApi(adoWorkItemId: number) {
    const res = await fetch("/api/mappings", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adoWorkItemId }),
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
        body: JSON.stringify({ adoWorkItemId, target }),
    });

    if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || "Failed to move mapping");
    }

    return res.json();
}

export function MappingsPage() {
    const queryClient = useQueryClient();
    const { month, year, setMonthYear } = useAppContext();

    const { data, isLoading, error } = useQuery({
        queryKey: ["mappings"],
        queryFn: fetchMappings,
    });

    const { data: typeColors } = useQuery({
        queryKey: ["workitem-type-colors"],
        queryFn: fetchTypeColors,
        staleTime: 60 * 60 * 1000,
    });

    const { data: adoConfig } = useQuery({
        queryKey: ["ado-config"],
        queryFn: fetchAdoConfig,
        staleTime: 60 * 60 * 1000,
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
                    Work Item <span className="text-amber-500">&harr;</span> Clarity Mappings
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
            <Card className="border-amber-500/20">
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
                            typeColors={typeColors?.types ?? {}}
                            adoConfig={adoConfig?.org ? (adoConfig as { org: string; project: string }) : null}
                            onRemove={(id) => removeMutation.mutate(id)}
                            onMove={(adoWorkItemId, target) => moveMutation.mutate({ adoWorkItemId, target })}
                        />
                    )}
                </CardContent>
            </Card>
        </div>
    );
}
