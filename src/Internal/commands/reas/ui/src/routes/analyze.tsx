import type { DashboardExport } from "@app/Internal/commands/reas/lib/api-export";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Skeleton } from "@ui/components/skeleton";
import { AlertTriangle, Search } from "lucide-react";
import { useState } from "react";
import type { AnalysisFormData } from "../components/AnalysisForm";
import { AnalysisForm } from "../components/AnalysisForm";
import { AnalysisResults } from "../components/AnalysisResults";

export const Route = createFileRoute("/analyze")({
    component: AnalyzePage,
});

interface AnalysisError {
    error: string;
}

function AnalyzePage() {
    const [results, setResults] = useState<DashboardExport | null>(null);

    const mutation = useMutation<DashboardExport, Error, AnalysisFormData>({
        mutationFn: async (formData) => {
            const body = {
                district: formData.district,
                type: formData.type,
                disposition: formData.disposition,
                periods: formData.periods.join(","),
                price: formData.price,
                area: formData.area,
                rent: formData.rent || undefined,
                monthlyCosts: formData.monthlyCosts || undefined,
            };

            const response = await fetch("/api/analysis", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                // biome-ignore lint/style/noRestrictedGlobals: browser-side fetch, SafeJSON not needed
                body: JSON.stringify(body),
            });

            if (!response.ok) {
                const errBody = (await response.json()) as AnalysisError;
                throw new Error(errBody.error || `Analysis failed (${response.status})`);
            }

            return response.json() as Promise<DashboardExport>;
        },
        onSuccess: (data) => {
            setResults(data);
        },
    });

    const handleSubmit = (formData: AnalysisFormData) => {
        setResults(null);
        mutation.mutate(formData);
    };

    return (
        <div className="max-w-7xl mx-auto px-6 py-8">
            {/* Page header */}
            <div className="flex items-center gap-3 mb-6">
                <div className="p-2 rounded bg-amber-500/10 border border-amber-500/30">
                    <Search className="w-5 h-5 text-amber-400" />
                </div>
                <div>
                    <h1 className="text-xl font-mono font-bold text-gray-200">Analyze</h1>
                    <p className="text-xs text-gray-500 font-mono">Run market analysis for a property or district</p>
                </div>
            </div>

            {/* Main layout: form left, results right */}
            <div className="grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-6 items-start">
                {/* Form */}
                <div className="lg:sticky lg:top-6">
                    <AnalysisForm onSubmit={handleSubmit} isLoading={mutation.isPending} />
                </div>

                {/* Results area */}
                <div className="min-w-0">
                    {mutation.isPending && <LoadingSkeleton />}

                    {mutation.isError && (
                        <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-6 animate-slide-up">
                            <div className="flex items-start gap-3">
                                <AlertTriangle className="h-5 w-5 text-red-400 shrink-0 mt-0.5" />
                                <div>
                                    <h3 className="text-sm font-mono font-bold text-red-400 mb-1">Analysis Failed</h3>
                                    <p className="text-xs font-mono text-red-300/70">{mutation.error.message}</p>
                                </div>
                            </div>
                        </div>
                    )}

                    {results && !mutation.isPending && <AnalysisResults data={results} />}

                    {!results && !mutation.isPending && !mutation.isError && <EmptyState />}
                </div>
            </div>
        </div>
    );
}

function LoadingSkeleton() {
    return (
        <div className="space-y-4 animate-slide-up">
            {/* Header skeleton */}
            <div className="flex items-center gap-3">
                <Skeleton variant="line" className="h-5 w-48" />
                <Skeleton variant="line" className="h-5 w-20" />
            </div>

            {/* Score + Yield row */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Skeleton variant="card" className="h-48" />
                <Skeleton variant="card" className="h-48" />
            </div>

            {/* Chart skeleton */}
            <Skeleton variant="card" className="h-56" />

            {/* Momentum skeleton */}
            <Skeleton variant="card" className="h-40" />

            {/* Table skeleton */}
            <Skeleton variant="card" className="h-64" />
        </div>
    );
}

function EmptyState() {
    return (
        <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="p-4 rounded-xl border border-white/5 bg-white/[0.02] mb-4">
                <Search className="h-8 w-8 text-gray-600" />
            </div>
            <h3 className="text-sm font-mono font-bold text-gray-400 mb-1">No Analysis Yet</h3>
            <p className="text-xs font-mono text-gray-600 max-w-sm">
                Fill in the form parameters and click "Run Analysis" to see market data, comparable sales, yield
                analysis, and investment scoring.
            </p>
        </div>
    );
}
