import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { Skeleton } from "@ui/components/skeleton";
import { MappingTable } from "../components/MappingTable";

async function fetchMappings() {
    const res = await fetch("/api/mappings");

    if (!res.ok) {
        throw new Error("Failed to fetch mappings");
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

export function MappingsPage() {
    const queryClient = useQueryClient();

    const { data, isLoading, error } = useQuery({
        queryKey: ["mappings"],
        queryFn: fetchMappings,
    });

    const removeMutation = useMutation({
        mutationFn: deleteMappingApi,
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["mappings"] });
        },
    });

    return (
        <div className="max-w-6xl mx-auto px-6 py-8">
            <div className="flex items-center justify-between mb-6">
                <h1 className="text-xl font-mono font-bold text-gray-200">
                    WORK ITEM <span className="text-amber-500">&harr;</span> CLARITY MAPPINGS
                </h1>
                {data?.mappings && (
                    <Badge variant="outline" className="font-mono">
                        {data.mappings.length} mappings
                    </Badge>
                )}
            </div>

            <Card className="border-amber-500/20">
                <CardHeader className="pb-3">
                    <CardTitle className="text-sm font-mono text-gray-400 flex items-center gap-2">
                        CONFIGURED MAPPINGS
                        {!data?.configured && !isLoading && (
                            <Badge variant="destructive" className="text-xs">
                                NOT CONFIGURED
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

                    {data && <MappingTable mappings={data.mappings} onRemove={(id) => removeMutation.mutate(id)} />}
                </CardContent>
            </Card>

            <div className="mt-4 text-xs text-gray-500 font-mono">
                To add mappings, use: <code className="text-amber-400">tools clarity link-workitems</code>
            </div>
        </div>
    );
}
