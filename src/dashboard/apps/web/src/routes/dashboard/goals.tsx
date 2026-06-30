import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import { AnimatedCard, EmptyState, FloatingActionButton, PageLoadingSpinner, TabBar } from "@ui/custom";
import { useAuth } from "@workos/authkit-tanstack-react-start/client";
import { CheckCircle2, Plus, Target, TrendingUp } from "lucide-react";
import { useState } from "react";
import { DashboardLayout } from "@/components/dashboard";
import { RouteError } from "@/components/RouteError";
import { RouteSkeleton } from "@/components/RouteSkeleton";
import { useServerEvents } from "@/lib/events/useServerEvents";
import type { GoalStatus } from "@/lib/goals/goals.server";
import { goalKeys } from "@/lib/goals/goals-keys";
import { useGoals } from "@/lib/goals/hooks/useGoals";
import { compareQuartersDesc } from "@/lib/goals/meta";
import { deriveProgress } from "@/lib/goals/progress";
import { GoalCard, GoalForm } from "./-goals";

export const Route = createFileRoute("/dashboard/goals")({
    component: GoalsPage,
    errorComponent: ({ error, reset }) => <RouteError error={error} reset={reset} />,
    pendingComponent: () => <RouteSkeleton />,
});

const DEV_USER_ID = "dev-user";

const STATUS_TABS = [
    { value: "active" as const, label: "Active", icon: Target },
    { value: "done" as const, label: "Done", icon: CheckCircle2 },
    { value: "archived" as const, label: "Archived", icon: TrendingUp },
];

function GoalsPage() {
    const { user, loading: authLoading } = useAuth();
    const userId = user?.id ?? (import.meta.env.DEV ? DEV_USER_ID : null);
    const queryClient = useQueryClient();

    useServerEvents({
        userId,
        domain: "goals",
        onEvent: () => queryClient.invalidateQueries({ queryKey: goalKeys.all }),
    });

    const {
        goals,
        loading,
        initialized,
        addGoal,
        setStatus,
        removeGoal,
        addKeyResult,
        patchKeyResult,
        removeKeyResult,
    } = useGoals(userId);

    const [formOpen, setFormOpen] = useState(false);
    const [statusTab, setStatusTab] = useState<GoalStatus>("active");

    const counts: Record<GoalStatus, number> = { active: 0, done: 0, archived: 0 };
    for (const g of goals) {
        counts[g.status]++;
    }

    const visible = goals.filter((g) => g.status === statusTab);

    const activeGoals = goals.filter((g) => g.status === "active");
    const avgProgress =
        activeGoals.length > 0
            ? Math.round(
                  activeGoals.reduce((acc, g) => acc + deriveProgress(g.progress, g.keyResults), 0) / activeGoals.length
              )
            : 0;

    // Group visible goals by quarter (newest first); empty quarter last.
    const quarters = Array.from(new Set(visible.map((g) => g.quarter))).sort(compareQuartersDesc);

    if (authLoading || (!initialized && loading)) {
        return (
            <DashboardLayout title="Goals & OKRs" description="Set quarterly goals and track key results">
                <PageLoadingSpinner label="Loading goals…" />
            </DashboardLayout>
        );
    }

    return (
        <DashboardLayout title="Goals & OKRs" description="Set quarterly goals and track them with key results">
            <div data-testid="goals-page" className="flex flex-col gap-6">
                {goals.length > 0 && (
                    <div data-testid="goals-summary" className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                        <SummaryTile label="Active" value={counts.active} icon={Target} colorClassName="text-primary" />
                        <SummaryTile
                            label="Completed"
                            value={counts.done}
                            icon={CheckCircle2}
                            colorClassName="text-emerald-400"
                        />
                        <SummaryTile
                            label="Avg progress"
                            value={`${avgProgress}%`}
                            icon={TrendingUp}
                            colorClassName="text-cyan-400"
                        />
                        <SummaryTile
                            label="Total"
                            value={goals.length}
                            icon={Target}
                            colorClassName="text-violet-400"
                        />
                    </div>
                )}

                {goals.length > 0 && (
                    <TabBar
                        tabs={STATUS_TABS}
                        activeTab={statusTab}
                        onTabChange={setStatusTab}
                        counts={counts}
                        theme="purple"
                    />
                )}

                {goals.length === 0 ? (
                    <div data-testid="goals-empty">
                        <EmptyState
                            icon={Target}
                            title="No goals yet"
                            description="Define your quarterly objectives and break them into measurable key results. Watch the rings fill as you make progress."
                            cta={
                                <Button
                                    data-testid="add-goal-button"
                                    onClick={() => setFormOpen(true)}
                                    size="lg"
                                    variant="brand"
                                    className="mt-2 gap-2"
                                >
                                    <Plus className="h-5 w-5" />
                                    Create your first goal
                                </Button>
                            }
                        />
                    </div>
                ) : visible.length === 0 ? (
                    <div data-testid="goals-empty-filtered">
                        <EmptyState
                            icon={Target}
                            title={`No ${statusTab} goals`}
                            description={
                                statusTab === "active"
                                    ? "Create a new goal to get started this quarter."
                                    : `Nothing here yet. Goals you mark ${statusTab} will show up in this tab.`
                            }
                            iconSize="md"
                            rings={false}
                            cta={
                                statusTab === "active" ? (
                                    <Button
                                        data-testid="add-goal-button"
                                        onClick={() => setFormOpen(true)}
                                        variant="brand"
                                        className="mt-2 gap-2"
                                    >
                                        <Plus className="h-4 w-4" />
                                        New goal
                                    </Button>
                                ) : undefined
                            }
                        />
                    </div>
                ) : (
                    <div className="flex flex-col gap-8">
                        {quarters.map((quarter) => {
                            const inQuarter = visible.filter((g) => g.quarter === quarter);
                            return (
                                <section key={quarter || "no-quarter"} className="flex flex-col gap-3">
                                    <div className="flex items-center gap-3">
                                        <h2 className="font-mono text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                                            {quarter || "No quarter"}
                                        </h2>
                                        <span className="font-mono text-[10px] text-muted-foreground/50">
                                            {inQuarter.length}
                                        </span>
                                        <div className="h-px flex-1 bg-border/50" />
                                    </div>
                                    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                                        {inQuarter.map((goal, i) => (
                                            <AnimatedCard key={goal.id} index={i} stagger={40}>
                                                <GoalCard
                                                    goal={goal}
                                                    onSetStatus={setStatus}
                                                    onDelete={removeGoal}
                                                    onAddKeyResult={addKeyResult}
                                                    onUpdateKeyResult={patchKeyResult}
                                                    onDeleteKeyResult={removeKeyResult}
                                                />
                                            </AnimatedCard>
                                        ))}
                                    </div>
                                </section>
                            );
                        })}
                    </div>
                )}
            </div>

            {goals.length > 0 && (
                <FloatingActionButton icon={Plus} onClick={() => setFormOpen(true)} label="New goal" />
            )}

            <GoalForm
                open={formOpen}
                onOpenChange={setFormOpen}
                onSubmit={async (input) => {
                    await addGoal(input);
                }}
            />
        </DashboardLayout>
    );
}

interface SummaryTileProps {
    label: string;
    value: string | number;
    icon: typeof Target;
    colorClassName: string;
}

function SummaryTile({ label, value, icon: Icon, colorClassName }: SummaryTileProps) {
    return (
        <Card variant="wow-static" className="flex flex-col gap-2 p-4">
            <Icon className={`h-4 w-4 ${colorClassName}`} />
            <span className={`text-2xl font-bold tabular-nums ${colorClassName}`}>{value}</span>
            <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{label}</span>
        </Card>
    );
}
