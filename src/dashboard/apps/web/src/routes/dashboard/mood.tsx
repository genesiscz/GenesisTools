import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { PageLoadingSpinner } from "@ui/custom";
import { useAuth } from "@workos/authkit-tanstack-react-start/client";
import { toast } from "sonner";
import { DashboardLayout } from "@/components/dashboard";
import { RouteError } from "@/components/RouteError";
import { RouteSkeleton } from "@/components/RouteSkeleton";
import { useServerEvents } from "@/lib/events/useServerEvents";
import { type MoodCheckInValues, useMood } from "@/lib/mood/hooks/useMood";
import { MOOD_SYNC_CHANNEL } from "@/lib/mood/hooks/useMoodQueries";
import { moodKeys } from "@/lib/mood/mood-keys";
import { useBroadcastInvalidation } from "@/lib/sync/useBroadcastInvalidation";
import { MoodCheckIn, MoodHistory, MoodStats, MoodTrendChart } from "./-mood";

export const Route = createFileRoute("/dashboard/mood")({
    component: MoodPage,
    errorComponent: ({ error, reset }) => <RouteError error={error} reset={reset} />,
    pendingComponent: () => <RouteSkeleton />,
});

const DEV_USER_ID = "dev-user";

function MoodPage() {
    const { user, loading: authLoading } = useAuth();
    const userId = user?.id ?? (import.meta.env.DEV ? DEV_USER_ID : null);
    const queryClient = useQueryClient();

    // Same-device tabs: receive broadcasts from sibling tabs' mutations.
    useBroadcastInvalidation(MOOD_SYNC_CHANNEL);

    // Cross-device: refetch when this user's mood changes on another device.
    useServerEvents({
        userId,
        domain: "mood",
        onEvent: () => queryClient.invalidateQueries({ queryKey: moodKeys.all }),
    });

    const { entries, loading, initialized, today, todayEntry, trend, insights, saveCheckIn, removeEntry, saving } =
        useMood(userId);

    if (authLoading || (!initialized && loading)) {
        return (
            <DashboardLayout title="Mood Journal" description="Daily mood check-ins and reflections">
                <PageLoadingSpinner label="Loading mood journal…" />
            </DashboardLayout>
        );
    }

    async function handleSave(values: MoodCheckInValues) {
        try {
            await saveCheckIn(values);
            toast.success("Mood logged for today");
        } catch (err) {
            console.error("[mood] save failed:", err);
            toast.error("Couldn't save your check-in");
        }
    }

    async function handleDelete(day: string) {
        try {
            await removeEntry(day);
            toast.success("Entry removed");
        } catch (err) {
            console.error("[mood] delete failed:", err);
            toast.error("Couldn't remove that entry");
        }
    }

    return (
        <DashboardLayout title="Mood Journal" description="Daily mood check-ins, trends, and reflections">
            <div data-testid="mood-page" className="grid grid-cols-1 gap-6 lg:grid-cols-5">
                {/* Left column: prominent check-in + history */}
                <div className="flex flex-col gap-6 lg:col-span-2">
                    <MoodCheckIn today={today} todayEntry={todayEntry} saving={saving} onSave={handleSave} />
                    <MoodHistory entries={entries} today={today} onDelete={handleDelete} />
                </div>

                {/* Right column: insights + trend */}
                <div className="flex flex-col gap-6 lg:col-span-3">
                    <MoodStats insights={insights} />
                    <MoodTrendChart trend={trend} />
                </div>
            </div>
        </DashboardLayout>
    );
}
