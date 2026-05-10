import type { SettingsPayload } from "@app/shops/types";
import { Skeleton } from "@app/utils/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { SettingsForm } from "@app/shops/ui/components/SettingsForm";

export const Route = createFileRoute("/settings")({
    component: SettingsPage,
});

function SettingsPage() {
    const settingsQuery = useQuery({
        queryKey: ["settings"],
        queryFn: async (): Promise<SettingsPayload> => {
            const res = await fetch("/api/settings");
            if (!res.ok) {
                throw new Error(`settings fetch failed: ${res.status}`);
            }

            return res.json();
        },
    });

    return (
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 space-y-5">
            <h1 className="font-mono tracking-[0.3em] text-sm text-muted-foreground uppercase">
                Settings :: <span className="text-foreground">Configuration</span>
            </h1>
            {settingsQuery.isLoading || !settingsQuery.data ? (
                <div className="space-y-4">
                    <Skeleton className="h-32 w-full rounded" />
                    <Skeleton className="h-48 w-full rounded" />
                    <Skeleton className="h-32 w-full rounded" />
                </div>
            ) : (
                <SettingsForm initial={settingsQuery.data} />
            )}
        </div>
    );
}
