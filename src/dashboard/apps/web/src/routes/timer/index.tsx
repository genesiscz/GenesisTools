import type { TimerInput } from "@dashboard/shared";
import { createFileRoute } from "@tanstack/react-router";
import { useAuth } from "@workos/authkit-tanstack-react-start/client";
import { Activity, Loader2, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { DashboardLayout } from "@/components/dashboard";
import { Button } from "@/components/ui/button";
import { ActivityLogSidebar, TimerCard } from "@/lib/timer/components";
import { useTimerStore } from "@/lib/timer/hooks/useTimerStore";
import { cn } from "@/lib/utils";
import "@/components/auth/cyberpunk.css";

export const Route = createFileRoute("/timer/")({
    component: TimerPage,
});

function TimerPage() {
    const { user, loading: authLoading } = useAuth();
    const userId = user?.id ?? null;
    const [activityLogOpen, setActivityLogOpen] = useState(false);

    const { timers, initialized, createTimer, deleteTimer } = useTimerStore(userId);

    // Count running timers
    const runningCount = timers.filter((t) => t.isRunning).length;

    // Track running state changes to refresh activity stats
    const [statsRefreshTrigger, setStatsRefreshTrigger] = useState(0);
    const prevRunningRef = useRef<Record<string, boolean>>({});

    useEffect(() => {
        // Check if any timer's running state changed
        const currentRunning: Record<string, boolean> = {};
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
            // Trigger stats refresh when any timer starts or pauses
            setStatsRefreshTrigger((prev) => prev + 1);
        }
    }, [timers]);

    // Add new timer
    async function handleAddTimer() {
        const input: TimerInput = {
            name: `Timer ${timers.length + 1}`,
            timerType: "stopwatch",
            isRunning: false,
            elapsedTime: 0,
            duration: 5 * 60 * 1000, // 5 minutes default for countdown
            laps: [],
            showTotal: true, // Default to visible
            firstStartTime: null,
            startTime: null,
            pomodoroSessionCount: 0,
        };
        await createTimer(input);
    }

    // Delete timer
    async function handleDeleteTimer(id: string) {
        await deleteTimer(id);
    }

    // Pop out timer (Phase 2)
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

    // Loading state - show until fully initialized
    if (authLoading || !initialized) {
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

/**
 * Empty state with call to action
 */
function EmptyState({ onAddTimer }: { onAddTimer: () => void }) {
    return (
        <div className="flex flex-col items-center justify-center py-24 px-6">
            {/* Decorative element */}
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
                {/* Ripple effects */}
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

            {/* Text */}
            <h2 className="text-xl font-semibold text-foreground/70 mb-2">No timers yet</h2>
            <p className="text-muted-foreground text-center max-w-md mb-8">
                Create your first timer to start tracking time. Stopwatch, countdown, or pomodoro - choose what works
                for you.
            </p>

            {/* CTA Button */}
            <Button onClick={onAddTimer} size="lg" className="gap-3 bg-primary hover:bg-primary/90">
                <Plus className="h-5 w-5" />
                Create your first timer
            </Button>
        </div>
    );
}
