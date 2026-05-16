import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@ui/components/button";
import { useAuth } from "@workos/authkit-tanstack-react-start/client";
import { Activity, Loader2, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { DashboardLayout } from "@/components/dashboard";
import { CHRONO_SYNC_CHANNEL, useBroadcastInvalidation } from "@/lib/sync/useBroadcastInvalidation";
import { ActivityLogSidebar, TimerCard } from "@/lib/timer/components";
import { useTimerSSE } from "@/lib/timer/hooks/useTimerSSE";
import { useTimerStore } from "@/lib/timer/hooks/useTimerStore";
import { requireAuthBeforeLoad } from "@/lib/auth/requireUser";
import { cn } from "@/lib/utils";
import "@/components/auth/cyberpunk.css";

export const Route = createFileRoute("/timer/")({
    beforeLoad: ({ location }) => requireAuthBeforeLoad(location.href),
    component: TimerPage,
});

const DEV_USER_ID = "dev-user";

function TimerPage() {
    const { user } = useAuth();
    const userId = user?.id ?? (import.meta.env.DEV ? DEV_USER_ID : null);

    // 3-channel sync: SSE (primary), BroadcastChannel (same-origin), refetchOnWindowFocus (safety net)
    useTimerSSE(userId);
    useBroadcastInvalidation(CHRONO_SYNC_CHANNEL);

    const [activityLogOpen, setActivityLogOpen] = useState(false);

    const { timers, initialized, loading, createTimer, deleteTimer } = useTimerStore(userId);

    // Count running timers (isRunning is 0/1 integer from drizzle)
    const runningCount = timers.filter((t) => t.isRunning).length;

    // Track running state changes to refresh activity stats
    const [statsRefreshTrigger, setStatsRefreshTrigger] = useState(0);
    const prevRunningRef = useRef<Record<string, number>>({});

    useEffect(() => {
        const currentRunning: Record<string, number> = {};
        let changed = false;

        for (const timer of timers) {
            currentRunning[timer.id] = timer.isRunning;

            if (
                prevRunningRef.current[timer.id] !== undefined &&
                prevRunningRef.current[timer.id] !== timer.isRunning
            ) {
                changed = true;
            }
        }

        prevRunningRef.current = currentRunning;

        if (changed) {
            setStatsRefreshTrigger((prev) => prev + 1);
        }
    }, [timers]);

    async function handleAddTimer() {
        await createTimer({
            name: `Timer ${timers.length + 1}`,
            timerType: "stopwatch",
            duration: 5 * 60 * 1000,
        });
    }

    async function handleDeleteTimer(id: string) {
        await deleteTimer(id);
    }

    function handlePopoutTimer(id: string) {
        const width = 400;
        const height = 500;
        const left = window.screen.width / 2 - width / 2;
        const top = window.screen.height / 2 - height / 2;
        window.open(
            `/timer/${id}`,
            `timer-${id}`,
            `width=${width},height=${height},left=${left},top=${top},toolbar=no,menubar=no`
        );
    }

    // Show loader only while the first timer fetch is in flight.
    // We don't block on authLoading: userId always resolves (real session or
    // dev fallback), so the timer query can proceed without waiting on auth.
    if (loading && !initialized) {
        return (
            <DashboardLayout title="Timer" description="Precision time tracking">
                <div className="flex items-center justify-center min-h-[60vh]">
                    <div className="flex flex-col items-center gap-4">
                        <Loader2 className="h-8 w-8 text-primary animate-spin" />
                        <span className="text-muted-foreground text-sm font-mono">Loading timers...</span>
                    </div>
                </div>
            </DashboardLayout>
        );
    }

    return (
        <DashboardLayout title="Timer" description="Precision time tracking">
            {/* Timer toolbar */}
            <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2 text-sm">
                        <span className="text-muted-foreground">
                            {timers.length} timer{timers.length !== 1 ? "s" : ""}
                        </span>
                        {runningCount > 0 && (
                            <span className="flex items-center gap-1.5 text-emerald-400">
                                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                                {runningCount} running
                            </span>
                        )}
                    </div>
                </div>

                <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => setActivityLogOpen(true)} className="gap-2">
                        <Activity className="h-4 w-4" />
                        <span className="hidden sm:inline">Activity</span>
                    </Button>

                    <Button onClick={handleAddTimer} size="sm" className="gap-2 bg-primary hover:bg-primary/90">
                        <Plus className="h-4 w-4" />
                        <span className="hidden sm:inline">Add Timer</span>
                    </Button>
                </div>
            </div>

            {/* Timer grid */}
            {timers.length === 0 ? (
                <EmptyState onAddTimer={handleAddTimer} />
            ) : (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 auto-rows-fr">
                    {timers.map((timer, index) => (
                        <div
                            key={timer.id}
                            className="animate-fade-in-up h-full"
                            style={{ animationDelay: `${index * 100}ms` }}
                        >
                            <TimerCard
                                timerId={timer.id}
                                userId={userId}
                                onDelete={handleDeleteTimer}
                                onPopout={handlePopoutTimer}
                                className="h-full"
                            />
                        </div>
                    ))}
                </div>
            )}

            {/* Activity Log Sidebar */}
            <ActivityLogSidebar
                userId={userId}
                timers={timers}
                isOpen={activityLogOpen}
                onClose={() => setActivityLogOpen(false)}
                refreshTrigger={statsRefreshTrigger}
            />
        </DashboardLayout>
    );
}

function EmptyState({ onAddTimer }: { onAddTimer: () => void }) {
    return (
        <div className="flex flex-col items-center justify-center py-24 px-6">
            <div
                className={cn(
                    "relative w-32 h-32 mb-8",
                    "flex items-center justify-center",
                    "rounded-full",
                    "bg-gradient-to-br from-primary/10 to-primary/5",
                    "border border-primary/20",
                    "animate-pulse-glow"
                )}
            >
                <div className="absolute inset-0 rounded-full border border-primary/20 animate-ripple" />
                <div className="absolute inset-0 rounded-full border border-primary/20 animate-ripple-delayed" />
                <div className="absolute inset-0 rounded-full border border-primary/20 animate-ripple-delayed-2" />

                <span
                    className="text-5xl font-mono font-bold text-primary/50"
                    style={{ fontFamily: "'JetBrains Mono', monospace" }}
                >
                    00:00
                </span>
            </div>

            <h2 className="text-xl font-semibold text-foreground/70 mb-2">No timers yet</h2>
            <p className="text-muted-foreground text-center max-w-md mb-8">
                Create your first timer to start tracking time. Stopwatch, countdown, or pomodoro - choose what works
                for you.
            </p>

            <Button onClick={onAddTimer} size="lg" className="gap-3 bg-primary hover:bg-primary/90">
                <Plus className="h-5 w-5" />
                Create your first timer
            </Button>
        </div>
    );
}
