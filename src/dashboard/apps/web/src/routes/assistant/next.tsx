import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "@ui/components/button";
import { ContextParkingBadge, EmptyState, MetaItem, MetaRow, PageLoadingSpinner, StreakBadge } from "@ui/custom";
import { FeatureCard, FeatureCardContent, FeatureCardHeader } from "@ui/custom/feature-card-nexus";
import { useAuth } from "@workos/authkit-tanstack-react-start/client";
import {
    AlertCircle,
    AlertTriangle,
    Calendar,
    ChevronRight,
    Clock,
    Compass,
    Play,
    RefreshCw,
    Sparkles,
} from "lucide-react";
import { useEffect, useState } from "react";
import { DashboardLayout } from "@/components/dashboard";
import { RouteError } from "@/components/RouteError";
import { RouteSkeleton } from "@/components/RouteSkeleton";
import { useTaskStore } from "@/lib/assistant/hooks";
import type { ContextParking, Task } from "@/lib/assistant/types";
import { formatFocusTime } from "@/lib/assistant/utils";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/assistant/next")({
    component: WhatsNextPage,
    errorComponent: ({ error, reset }) => <RouteError error={error} reset={reset} />,
    pendingComponent: () => <RouteSkeleton />,
});

interface Recommendation {
    task: Task;
    score: number;
    reasons: string[];
    parkingContext?: ContextParking | null;
}

function WhatsNextPage() {
    const { user, loading: authLoading } = useAuth();
    const userId = user?.id ?? null;

    const { tasks, streak, loading, initialized, updateTask, getActiveParking } = useTaskStore(userId);

    const [recommendation, setRecommendation] = useState<Recommendation | null>(null);
    const [alternatives, setAlternatives] = useState<Recommendation[]>([]);
    const [loadingRecommendation, setLoadingRecommendation] = useState(false);

    // Get active (non-completed) tasks
    const activeTasks = tasks.filter((t) => t.status !== "completed");

    // Calculate recommendations when tasks change
    useEffect(() => {
        let mounted = true;

        async function calculateRecommendations() {
            const active = tasks.filter((t) => t.status !== "completed");

            if (active.length === 0) {
                if (mounted) {
                    setRecommendation(null);
                    setAlternatives([]);
                }
                return;
            }

            setLoadingRecommendation(true);

            try {
                const scored: Recommendation[] = [];

                for (const task of active) {
                    const { score, reasons } = calculatePriorityScore(task);
                    const parkingContext = await getActiveParking(task.id);

                    scored.push({
                        task,
                        score,
                        reasons,
                        parkingContext,
                    });
                }

                // Sort by score descending
                scored.sort((a, b) => b.score - a.score);

                if (mounted) {
                    // Top recommendation
                    setRecommendation(scored[0] || null);

                    // Next 3 alternatives
                    setAlternatives(scored.slice(1, 4));
                }
            } finally {
                if (mounted) {
                    setLoadingRecommendation(false);
                }
            }
        }

        if (initialized) {
            calculateRecommendations();
        }

        return () => {
            mounted = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tasks, initialized, calculatePriorityScore, getActiveParking]);

    /**
     * Calculate priority score for a task
     * Higher score = higher priority
     */
    function calculatePriorityScore(task: Task): { score: number; reasons: string[] } {
        let score = 0;
        const reasons: string[] = [];

        // 1. Urgency weight (critical > important > nice-to-have)
        switch (task.urgencyLevel) {
            case "critical":
                score += 100;
                reasons.push("Critical priority");
                break;
            case "important":
                score += 50;
                reasons.push("Important priority");
                break;
            case "nice-to-have":
                score += 10;
                break;
        }

        // 2. Shipping blocker bonus
        if (task.isShippingBlocker) {
            score += 50;
            reasons.push("Blocks shipping");
        }

        // 3. Deadline proximity
        if (task.deadline) {
            const now = new Date();
            const deadline = new Date(task.deadline);
            const daysUntil = Math.floor((deadline.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

            if (daysUntil < 0) {
                score += 80; // Overdue
                reasons.push("Overdue!");
            } else if (daysUntil === 0) {
                score += 60; // Due today
                reasons.push("Due today");
            } else if (daysUntil === 1) {
                score += 40; // Due tomorrow
                reasons.push("Due tomorrow");
            } else if (daysUntil <= 3) {
                score += 25; // Due within 3 days
                reasons.push(`Due in ${daysUntil} days`);
            } else if (daysUntil <= 7) {
                score += 10; // Due within a week
            }
        }

        // 4. In-progress bonus (reduce context switching)
        if (task.status === "in-progress") {
            score += 30;
            reasons.push("Already started");
        }

        // 5. Has context parked (easier to resume)
        if (task.contextParkingLot) {
            score += 15;
            reasons.push("Has context saved");
        }

        // 6. Time already invested
        if (task.focusTimeLogged > 60) {
            score += 10;
            reasons.push("Time invested");
        }

        return { score, reasons };
    }

    // Handle start work
    async function handleStartWork(taskId: string) {
        await updateTask(taskId, { status: "in-progress" });
    }

    // Refresh recommendations
    function handleRefresh() {
        // Trigger recalculation
        setLoadingRecommendation(true);
        setTimeout(() => setLoadingRecommendation(false), 300);
    }

    // Loading state
    if (authLoading || (!initialized && loading)) {
        return (
            <DashboardLayout title="What's Next" description="Your priority recommendation">
                <PageLoadingSpinner label="Calculating priorities..." />
            </DashboardLayout>
        );
    }

    return (
        <DashboardLayout
            title="What's Next"
            description="Smart task prioritization based on urgency, deadline, and context"
        >
            {/* Header with streak and refresh */}
            <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-4">
                    {streak && streak.currentStreakDays > 0 && <StreakBadge days={streak.currentStreakDays} />}
                </div>

                <Button
                    variant="outline"
                    size="sm"
                    onClick={handleRefresh}
                    disabled={loadingRecommendation}
                    className="gap-2"
                >
                    <RefreshCw className={cn("h-4 w-4", loadingRecommendation && "animate-spin")} />
                    Refresh
                </Button>
            </div>

            {/* No tasks state */}
            {activeTasks.length === 0 ? (
                <NoTasksEmptyState />
            ) : (
                <div className="grid gap-6 lg:grid-cols-3">
                    {/* Main recommendation - 2 columns */}
                    <div className="lg:col-span-2">
                        {recommendation && (
                            <RecommendationCard
                                recommendation={recommendation}
                                onStartWork={() => handleStartWork(recommendation.task.id)}
                                isPrimary
                            />
                        )}
                    </div>

                    {/* Alternatives - 1 column */}
                    <div className="space-y-4">
                        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                            Also Consider
                        </h3>

                        {alternatives.length === 0 ? (
                            <p className="text-sm text-muted-foreground">No other tasks available.</p>
                        ) : (
                            alternatives.map((alt) => (
                                <RecommendationCard
                                    key={alt.task.id}
                                    recommendation={alt}
                                    onStartWork={() => handleStartWork(alt.task.id)}
                                />
                            ))
                        )}

                        {/* View all tasks link */}
                        <Button asChild variant="ghost" className="w-full justify-between">
                            <Link to="/assistant/tasks">
                                View all tasks
                                <ChevronRight className="h-4 w-4" />
                            </Link>
                        </Button>
                    </div>
                </div>
            )}
        </DashboardLayout>
    );
}

/**
 * Recommendation card component
 */
function RecommendationCard({
    recommendation,
    onStartWork,
    isPrimary = false,
}: {
    recommendation: Recommendation;
    onStartWork: () => void;
    isPrimary?: boolean;
}) {
    const { task, reasons, parkingContext } = recommendation;

    const urgencyConfig = {
        critical: { icon: AlertTriangle, label: "Critical", color: "text-red-400" },
        important: { icon: AlertCircle, label: "Important", color: "text-orange-400" },
        "nice-to-have": { icon: Sparkles, label: "Nice to Have", color: "text-yellow-400" },
    };

    const urgency = urgencyConfig[task.urgencyLevel];
    const UrgencyIcon = urgency.icon;

    return (
        <FeatureCard
            color={task.urgencyLevel === "critical" ? "rose" : task.urgencyLevel === "important" ? "amber" : "purple"}
            className={cn(isPrimary && "border-2")}
        >
            <FeatureCardHeader>
                {/* Header with urgency badge */}
                <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                        <UrgencyIcon className={cn("h-4 w-4", urgency.color)} />
                        <span className={cn("text-xs font-semibold uppercase", urgency.color)}>{urgency.label}</span>
                    </div>

                    {isPrimary && (
                        <span className="text-[10px] uppercase tracking-wider font-bold text-purple-400 px-2 py-1 rounded bg-purple-500/20">
                            Recommended
                        </span>
                    )}
                </div>

                {/* Task title */}
                <Link to="/assistant/tasks/$taskId" params={{ taskId: task.id }} className="group/link">
                    <h3
                        className={cn(
                            "font-semibold leading-snug transition-colors",
                            "group-hover/link:text-purple-400",
                            isPrimary ? "text-xl" : "text-base"
                        )}
                    >
                        {task.title}
                    </h3>
                </Link>

                {/* Description */}
                {isPrimary && task.description && (
                    <p className="text-sm text-muted-foreground mt-2 line-clamp-2">{task.description}</p>
                )}

                {/* Priority reasons */}
                <div className="flex flex-wrap gap-2 mt-3">
                    {reasons.slice(0, isPrimary ? 4 : 2).map((reason, i) => (
                        <span key={i} className="text-[10px] px-2 py-0.5 rounded bg-muted/50 text-muted-foreground">
                            {reason}
                        </span>
                    ))}
                </div>

                {/* Metadata row */}
                <MetaRow className="mt-4">
                    {task.deadline && (
                        <MetaItem icon={<Calendar />}>{formatDeadline(new Date(task.deadline))}</MetaItem>
                    )}
                    {task.focusTimeLogged > 0 && (
                        <MetaItem icon={<Clock />}>{formatFocusTime(task.focusTimeLogged)}</MetaItem>
                    )}
                </MetaRow>

                {/* Context parking preview */}
                {isPrimary && parkingContext && (
                    <ContextParkingBadge content={parkingContext.content} label="Where you left off" size="preview" />
                )}
            </FeatureCardHeader>

            <FeatureCardContent className={cn(!isPrimary && "pt-0")}>
                <Button
                    onClick={onStartWork}
                    variant={isPrimary ? "brand" : "ghost"}
                    className={cn(
                        "w-full gap-2",
                        !isPrimary &&
                            "bg-transparent border border-purple-500/30 text-purple-400 hover:bg-purple-500/10"
                    )}
                    size={isPrimary ? "default" : "sm"}
                >
                    <Play className="h-4 w-4" />
                    {task.status === "in-progress" ? "Continue" : "Start Working"}
                </Button>
            </FeatureCardContent>
        </FeatureCard>
    );
}

/**
 * Empty state when no tasks
 */
function NoTasksEmptyState() {
    return (
        <EmptyState
            icon={Compass}
            title="All caught up!"
            description="You have no active tasks. Great job! Add some tasks to get recommendations."
            rings={false}
            cta={
                <Button asChild variant="brand" className="gap-2">
                    <Link to="/assistant/tasks">
                        Go to Tasks
                        <ChevronRight className="h-4 w-4" />
                    </Link>
                </Button>
            }
        />
    );
}

// Helper functions

function formatDeadline(deadline: Date): string {
    const now = new Date();
    const diff = deadline.getTime() - now.getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));

    if (diff < 0) {
        return "Overdue";
    }
    if (days === 0) {
        return "Due today";
    }
    if (days === 1) {
        return "Due tomorrow";
    }
    return `${days} days left`;
}
