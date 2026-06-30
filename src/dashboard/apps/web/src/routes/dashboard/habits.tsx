import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@ui/components/button";
import { AnimatedCard, EmptyState, PageLoadingSpinner, StatCardNexus } from "@ui/custom";
import { useAuth } from "@workos/authkit-tanstack-react-start/client";
import { CalendarCheck, CheckCircle2, Flame, Plus, Target } from "lucide-react";
import { useState } from "react";
import { DashboardLayout } from "@/components/dashboard";
import { RouteError } from "@/components/RouteError";
import { RouteSkeleton } from "@/components/RouteSkeleton";
import { useServerEvents } from "@/lib/events/useServerEvents";
import { HABITS_SYNC_CHANNEL } from "@/lib/habits/habits-channel";
import { habitKeys } from "@/lib/habits/habits-keys";
import { useHabits } from "@/lib/habits/hooks/useHabits";
import { useBroadcastInvalidation } from "@/lib/sync/useBroadcastInvalidation";
import { HabitCard, HabitForm } from "./-habits";

export const Route = createFileRoute("/dashboard/habits")({
    component: HabitsPage,
    errorComponent: ({ error, reset }) => <RouteError error={error} reset={reset} />,
    pendingComponent: () => <RouteSkeleton />,
});

const DEV_USER_ID = "dev-user";

function HabitsPage() {
    const { user, loading: authLoading } = useAuth();
    const userId = user?.id ?? (import.meta.env.DEV ? DEV_USER_ID : null);
    const queryClient = useQueryClient();

    // Cross-tab sync (same device) + cross-device sync (SSE bus).
    useBroadcastInvalidation(HABITS_SYNC_CHANNEL);
    useServerEvents({
        userId,
        domain: "habits",
        onEvent: () => queryClient.invalidateQueries({ queryKey: habitKeys.all }),
    });

    const { habits, loading, initialized, addHabit, toggleToday, archive, togglingId } = useHabits(userId);
    const [formOpen, setFormOpen] = useState(false);

    if (authLoading || (!initialized && loading)) {
        return (
            <DashboardLayout title="Habits" description="Build streaks and track daily habits">
                <PageLoadingSpinner label="Loading habits…" />
            </DashboardLayout>
        );
    }

    const doneToday = habits.filter((h) => h.doneToday).length;
    const longestStreak = habits.reduce((max, h) => Math.max(max, h.currentStreak), 0);
    const activeStreaks = habits.filter((h) => h.currentStreak > 0).length;

    return (
        <DashboardLayout title="Habits" description="Build streaks with a GitHub-style heatmap for every habit">
            <div data-testid="habits-page" className="flex flex-col gap-6">
                {habits.length > 0 && (
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="habits-summary">
                        <StatCardNexus
                            icon={<CalendarCheck />}
                            value={String(habits.length)}
                            label="Habits"
                            color="primary"
                        />
                        <StatCardNexus
                            icon={<CheckCircle2 />}
                            value={`${doneToday}/${habits.length}`}
                            label="Done today"
                            color="accent"
                        />
                        <StatCardNexus
                            icon={<Flame />}
                            value={String(longestStreak)}
                            label="Best streak"
                            color="primary"
                        />
                        <StatCardNexus
                            icon={<Target />}
                            value={String(activeStreaks)}
                            label="Active streaks"
                            color="accent"
                        />
                    </div>
                )}

                {habits.length === 0 ? (
                    <div data-testid="habits-empty">
                        <EmptyState
                            icon={CalendarCheck}
                            title="No habits yet"
                            description="Track a daily or weekly habit and watch a GitHub-style streak grid fill in, one day at a time."
                            cta={
                                <Button
                                    onClick={() => setFormOpen(true)}
                                    size="lg"
                                    variant="brand"
                                    className="mt-2 gap-2"
                                    data-testid="add-habit-button"
                                >
                                    <Plus className="h-5 w-5" />
                                    Create your first habit
                                </Button>
                            }
                        />
                    </div>
                ) : (
                    <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
                        {habits.map((habit, i) => (
                            <AnimatedCard key={habit.id} index={i} stagger={50}>
                                <HabitCard
                                    habit={habit}
                                    pending={togglingId === habit.id}
                                    onToggleToday={toggleToday}
                                    onArchive={archive}
                                />
                            </AnimatedCard>
                        ))}
                    </div>
                )}
            </div>

            {habits.length > 0 && (
                <Button
                    onClick={() => setFormOpen(true)}
                    variant="brand"
                    size="lg"
                    aria-label="New habit"
                    data-testid="add-habit-button"
                    className="fixed bottom-8 right-8 z-50 h-14 w-14 rounded-full p-0"
                >
                    <Plus className="h-6 w-6" />
                </Button>
            )}

            <HabitForm
                open={formOpen}
                onOpenChange={setFormOpen}
                onSubmit={async (input) => {
                    await addHabit(input);
                }}
            />
        </DashboardLayout>
    );
}
