import type { SavedPropertyRow, SavePropertyInput } from "@app/Internal/commands/reas/lib/store";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Skeleton } from "@ui/components/skeleton";
import { toast } from "@ui/index";
import { Star } from "lucide-react";
import { useCallback } from "react";
import { AddPropertyForm } from "../components/watchlist/AddPropertyForm";
import { PropertyCard } from "../components/watchlist/PropertyCard";

export const Route = createFileRoute("/watchlist")({
    component: WatchlistPage,
});

interface PropertiesResponse {
    properties: SavedPropertyRow[];
}

interface DistrictsResponse {
    districts: string[];
    praha: string[];
}

function useProperties() {
    return useQuery<PropertiesResponse>({
        queryKey: ["properties"],
        queryFn: async () => {
            const res = await fetch("/api/properties");

            if (!res.ok) {
                throw new Error("Failed to fetch properties");
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

function WatchlistPage() {
    const queryClient = useQueryClient();
    const { data: propertiesData, isLoading: propertiesLoading } = useProperties();
    const { data: districtsData } = useDistricts();

    const allDistricts = districtsData
        ? [...districtsData.praha, ...districtsData.districts.filter((d) => !districtsData.praha.includes(d))]
        : [];

    const addMutation = useMutation({
        mutationFn: async (input: SavePropertyInput) => {
            const res = await fetch("/api/properties", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: globalThis.JSON.stringify(input),
            });

            if (!res.ok) {
                const body = (await res.json()) as { error?: string };
                throw new Error(body.error ?? "Failed to add property");
            }

            return res.json();
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["properties"] });
            toast.success("Property added to watchlist");
        },
        onError: (err: Error) => {
            toast.error(err.message);
        },
    });

    const deleteMutation = useMutation({
        mutationFn: async (id: number) => {
            const res = await fetch(`/api/properties?id=${id}`, {
                method: "DELETE",
            });

            if (!res.ok) {
                throw new Error("Failed to delete property");
            }

            return res.json();
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["properties"] });
            toast.success("Property removed from watchlist");
        },
        onError: (err: Error) => {
            toast.error(err.message);
        },
    });

    const handleRefresh = useCallback(
        async (id: number) => {
            const res = await fetch(`/api/properties?id=${id}`, {
                method: "PATCH",
            });

            if (!res.ok) {
                const body = (await res.json()) as { error?: string };
                toast.error(body.error ?? "Failed to refresh property");
                return;
            }

            await queryClient.invalidateQueries({ queryKey: ["properties"] });
            toast.success("Analysis refreshed");
        },
        [queryClient]
    );

    const handleDelete = useCallback(
        (id: number) => {
            deleteMutation.mutate(id);
        },
        [deleteMutation]
    );

    const handleAdd = useCallback(
        async (input: SavePropertyInput) => {
            await addMutation.mutateAsync(input);
        },
        [addMutation]
    );

    const properties = propertiesData?.properties ?? [];

    return (
        <div className="max-w-6xl mx-auto px-6 py-8">
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-3">
                    <div className="p-2 rounded bg-amber-500/10 border border-amber-500/30">
                        <Star className="w-5 h-5 text-amber-400" />
                    </div>
                    <div>
                        <h1 className="text-xl font-mono font-bold text-gray-200">Watchlist</h1>
                        <p className="text-xs text-gray-500 font-mono">Track saved properties and monitor changes</p>
                    </div>
                </div>

                <AddPropertyForm districts={allDistricts} onAdd={handleAdd} />
            </div>

            {/* Loading state */}
            {propertiesLoading && (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {["skeleton-a", "skeleton-b", "skeleton-c"].map((key) => (
                        <div key={key} className="border border-white/5 rounded-lg p-4 space-y-3">
                            <Skeleton variant="text" className="h-4 w-2/3" />
                            <Skeleton variant="text" className="h-3 w-1/2" />
                            <Skeleton variant="text" className="h-3 w-3/4" />
                            <Skeleton variant="text" className="h-3 w-1/3" />
                            <div className="flex gap-2 pt-2">
                                <Skeleton variant="text" className="h-7 w-20" />
                                <Skeleton variant="text" className="h-7 w-16" />
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {/* Property grid */}
            {!propertiesLoading && properties.length > 0 && (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {properties.map((property) => (
                        <PropertyCard
                            key={property.id}
                            property={property}
                            onRefresh={handleRefresh}
                            onDelete={handleDelete}
                        />
                    ))}
                </div>
            )}

            {/* Empty state */}
            {!propertiesLoading && properties.length === 0 && (
                <div className="border border-white/5 rounded-lg p-8 text-center">
                    <Star className="w-8 h-8 text-gray-600 mx-auto mb-3" />
                    <p className="text-sm text-gray-500 font-mono mb-1">No properties in watchlist</p>
                    <p className="text-xs text-gray-600 font-mono">
                        Add a property to track its investment metrics over time
                    </p>
                </div>
            )}
        </div>
    );
}
