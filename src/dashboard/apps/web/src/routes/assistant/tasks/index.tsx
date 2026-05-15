import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@ui/components/button";
import {
    AnimatedCard,
    KbdShortcut,
    PageLoadingSpinner,
    EmptyState as SharedEmptyState,
    StreakBadge,
    ViewModeToggle,
} from "@ui/custom";
import { useAuth } from "@workos/authkit-tanstack-react-start/client";
import { Kanban, LayoutGrid, ListTodo, ParkingCircle, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { DashboardLayout } from "@/components/dashboard";
import { ContextParkingModal, TaskCard, TaskForm } from "@/lib/assistant/components";
import { useCommunicationLog, useContextParking, useDeadlineRisk, useTaskStore } from "@/lib/assistant/hooks";
import type {
    ContextParkingInput,
    DeadlineRisk,
    Task,
    TaskInput,
    TaskStatus,
    UrgencyLevel,
} from "@/lib/assistant/types";
import { ASSISTANT_SYNC_CHANNEL, useBroadcastInvalidation } from "@/lib/sync/useBroadcastInvalidation";
import { CelebrationManagerProvider, useCelebrationManager } from "../-components/celebrations";
import type { EscalationResolutionData } from "../-components/escalation";
import { EscalationAlert, EscalationWidget } from "../-components/escalation";
import { KanbanBoard } from "../-components/kanban";

export const Route = createFileRoute("/assistant/tasks/")({
    component: TasksPageWrapper,
});

/**
 * Wrapper component that provides the celebration context and cross-tab sync.
 * Subscribes to assistant query invalidations broadcast from other tabs.
 */
function TasksPageWrapper() {
    useBroadcastInvalidation(ASSISTANT_SYNC_CHANNEL);

    return (
        <CelebrationManagerProvider>
            <TasksPage />
        </CelebrationManagerProvider>
    );
}

type ViewMode = "kanban" | "grid";

function TasksPage() {
    const { user, loading: authLoading } = useAuth();
    const userId = user?.id ?? null;

    const {
        tasks,
        streak,
        loading,
        initialized,
        createTask,
        updateTask,
        completeTask,
        parkContext,
        getCompletionStats,
    } = useTaskStore(userId);

    const { risks, calculateAllRisks } = useDeadlineRisk(userId);

    const { createEntry } = useCommunicationLog(userId);

    const celebrations = useCelebrationManager();

    const [createDialogOpen, setCreateDialogOpen] = useState(false);
    const [viewMode, setViewMode] = useState<ViewMode>("kanban");
    const [defaultStatus, setDefaultStatus] = useState<TaskStatus>("backlog");

    // Escalation modal state
    const [escalationModalData, setEscalationModalData] = useState<{
        task: Task;
        risk: DeadlineRisk;
    } | null>(null);

    // Context parking modal with Cmd+P shortcut
    const contextParking = useContextParking();

    // Track tasks completed today
    const tasksCompletedTodayRef = useRef(0);
    const lastCheckDateRef = useRef<string>("");

    // Calculate tasks completed today
    useEffect(() => {
        const today = new Date().toDateString();

        // Reset counter if day changed
        if (lastCheckDateRef.current !== today) {
            tasksCompletedTodayRef.current = 0;
            lastCheckDateRef.current = today;
        }

        // Count tasks completed today
        const completedToday = tasks.filter((t) => {
            if (t.status !== "completed" || !t.completedAt) {
                return false;
            }
            return new Date(t.completedAt).toDateString() === today;
        }).length;

        tasksCompletedTodayRef.current = completedToday;
    }, [tasks]);

    // Calculate risks when tasks change
    useEffect(() => {
        if (userId && tasks.length > 0) {
            calculateAllRisks(tasks);
        }
    }, [userId, tasks, calculateAllRisks]);

    // Get risk for a specific task
    function getRiskForTask(taskId: string): DeadlineRisk | undefined {
        return risks.find((r) => r.taskId === taskId);
    }

    // Counts for stats
    const counts = {
        active: tasks.filter((t) => t.status !== "completed").length,
        critical: tasks.filter((t) => t.urgencyLevel === "critical" && t.status !== "completed").length,
        inProgress: tasks.filter((t) => t.status === "in-progress").length,
        blocked: tasks.filter((t) => t.status === "blocked").length,
    };

    // Handle task creation
    async function handleCreateTask(input: TaskInput) {
        await createTask({
            ...input,
            status: defaultStatus,
        });
    }

    // Handle task completion with celebrations
    async function handleCompleteTask(taskId: string) {
        const result = await completeTask(taskId);

        if (result) {
            const { task, newBadges } = result;
            const stats = await getCompletionStats();
            const totalCompleted = stats?.totalTasksCompleted ?? 0;

            // Trigger celebration
            celebrations.celebrateTaskCompletion(task, streak, newBadges, totalCompleted);

            // Update today's count and check for daily goal/speedrunner
            const today = new Date().toDateString();
            if (lastCheckDateRef.current === today) {
                tasksCompletedTodayRef.current += 1;
                const todayCount = tasksCompletedTodayRef.current;

                // Check for daily goal (3 tasks) or speedrunner (5 tasks)
                if (todayCount === 3 || todayCount === 5) {
                    celebrations.celebrateDailyGoal(todayCount);
                }
            }

            // Check for streak milestone
            if (streak && streak.currentStreakDays > 0) {
                const milestones = [1, 3, 5, 7, 14, 30, 60, 100];
                if (milestones.includes(streak.currentStreakDays)) {
                    celebrations.celebrateStreakMilestone(streak.currentStreakDays);
                }
            }

            // Celebrate new badges
            for (const badge of newBadges) {
                celebrations.celebrateBadgeEarned(badge);
            }
        }
    }

    // Handle status change from Kanban drag
    async function handleStatusChange(taskId: string, newStatus: TaskStatus) {
        // If moving to completed, use completeTask for celebration
        if (newStatus === "completed") {
            await handleCompleteTask(taskId);
        } else {
            await updateTask(taskId, { status: newStatus });
        }
    }

    // Open task form with default status for column
    function handleOpenTaskForm(status: TaskStatus) {
        setDefaultStatus(status);
        setCreateDialogOpen(true);
    }

    // Handle context parking
    async function handleParkContext(input: ContextParkingInput) {
        await parkContext(input);
    }

    // Handle risk click - opens escalation modal
    function handleRiskClick(taskId: string) {
        const task = tasks.find((t) => t.id === taskId);
        const risk = getRiskForTask(taskId);
        if (task && risk) {
            setEscalationModalData({ task, risk });
        }
    }

    // Handle escalation resolution
    async function handleEscalationResolve(taskId: string, data: EscalationResolutionData) {
        // Handle different resolution options
        switch (data.option) {
            case "extend":
                if (data.newDeadline) {
                    await updateTask(taskId, { deadline: data.newDeadline });
                }
                break;
            case "help": {
                const task = tasks.find((t) => t.id === taskId);
                if (task && userId) {
                    await createEntry({
                        source: "manual",
                        title: `Help requested: ${task.title}`,
                        content: `Asked ${data.helperName ?? "team"} for help.\n\n${data.helperNotes ?? ""}`.trim(),
                        relatedTaskIds: [taskId],
                        sentiment: "context",
                    });
                }
                break;
            }
            case "scope":
                // Could update task description with cut scope items
                if (data.scopeItems && data.scopeItems.length > 0) {
                    const task = tasks.find((t) => t.id === taskId);
                    if (task) {
                        const scopeNote = `\n\n[Scope Cut]\n- ${data.scopeItems.join("\n- ")}`;
                        await updateTask(taskId, {
                            description: (task.description || "") + scopeNote,
                        });
                    }
                }
                break;
            case "accept": {
                const task = tasks.find((t) => t.id === taskId);
                if (task) {
                    const acceptSuffix = `\n\n[Risk Accepted]\n${data.acceptanceNote ?? ""}`.trim();
                    await updateTask(taskId, {
                        description: (task.description || "") + acceptSuffix,
                    });
                }
                break;
            }
        }

        // Recalculate risks
        await calculateAllRisks(tasks);
        setEscalationModalData(null);
    }

    // Loading state
    if (authLoading || (!initialized && loading)) {
        return (
            <DashboardLayout title="Tasks" description="Manage your tasks">
                <PageLoadingSpinner label="Loading tasks..." />
            </DashboardLayout>
        );
    }

    return (
        <DashboardLayout title="Tasks" description="Drag tasks between columns to update status">
            {/* Toolbar */}
            <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-4">
                    {/* Task counts */}
                    <div className="flex items-center gap-3 text-sm">
                        <span className="text-muted-foreground">{counts.active} active</span>
                        {counts.critical > 0 && (
                            <span className="flex items-center gap-1 text-red-400 font-medium">
                                <span className="h-1.5 w-1.5 rounded-full bg-red-400 animate-pulse" />
                                {counts.critical} critical
                            </span>
                        )}
                        {counts.inProgress > 0 && (
                            <span className="flex items-center gap-1 text-amber-400">
                                {counts.inProgress} in progress
                            </span>
                        )}
                        {counts.blocked > 0 && (
                            <span className="flex items-center gap-1 text-rose-400">{counts.blocked} blocked</span>
                        )}
                    </div>

                    {/* Streak indicator */}
                    {streak && streak.currentStreakDays > 0 && <StreakBadge days={streak.currentStreakDays} />}

                    {/* Escalation widget - shows deadline risks */}
                    <EscalationWidget userId={userId} tasks={tasks} onResolve={handleEscalationResolve} />
                </div>

                <div className="flex items-center gap-2">
                    {/* Park context button */}
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={contextParking.open}
                        className="gap-2"
                        title="Park context (Cmd+P)"
                    >
                        <ParkingCircle className="h-4 w-4" />
                        <span className="hidden sm:inline">Park</span>
                        <KbdShortcut keys={["Cmd P"]} className="hidden lg:inline-flex" />
                    </Button>

                    {/* View mode toggle */}
                    <ViewModeToggle
                        modes={[
                            { value: "kanban", label: "Kanban", icon: Kanban },
                            { value: "grid", label: "Grid", icon: LayoutGrid },
                        ]}
                        value={viewMode}
                        onChange={setViewMode}
                    />

                    {/* Create button */}
                    <Button
                        onClick={() => {
                            setDefaultStatus("backlog");
                            setCreateDialogOpen(true);
                        }}
                        size="sm"
                        variant="brand"
                        className="gap-2"
                    >
                        <Plus className="h-4 w-4" />
                        <span className="hidden sm:inline">Add Task</span>
                    </Button>
                </div>
            </div>

            {/* Board/Grid content */}
            {tasks.length === 0 ? (
                <TasksEmptyState onAddTask={() => setCreateDialogOpen(true)} />
            ) : viewMode === "kanban" ? (
                <KanbanBoard
                    tasks={tasks}
                    onStatusChange={handleStatusChange}
                    onAddTask={handleCreateTask}
                    onOpenTaskForm={handleOpenTaskForm}
                />
            ) : (
                <GridView tasks={tasks} risks={risks} onRiskClick={handleRiskClick} onComplete={handleCompleteTask} />
            )}

            {/* Create task dialog */}
            <TaskForm
                open={createDialogOpen}
                onOpenChange={setCreateDialogOpen}
                onSubmit={handleCreateTask}
                initialValues={{ status: defaultStatus }}
            />

            {/* Context parking modal (Cmd+P) */}
            <ContextParkingModal
                open={contextParking.isOpen}
                onOpenChange={contextParking.setIsOpen}
                tasks={tasks}
                onPark={handleParkContext}
            />

            {/* Escalation modal */}
            {escalationModalData && (
                <EscalationAlert
                    open={!!escalationModalData}
                    onOpenChange={(open) => !open && setEscalationModalData(null)}
                    task={escalationModalData.task}
                    risk={escalationModalData.risk}
                    onResolve={handleEscalationResolve}
                />
            )}
        </DashboardLayout>
    );
}

/**
 * Grid view component (preserves original grid functionality)
 */
function GridView({
    tasks,
    risks,
    onRiskClick,
    onComplete,
}: {
    tasks: Task[];
    risks: DeadlineRisk[];
    onRiskClick: (taskId: string) => void;
    onComplete?: (taskId: string) => void;
}) {
    // Urgency order for sorting
    const urgencyOrder: Record<UrgencyLevel, number> = {
        critical: 0,
        important: 1,
        "nice-to-have": 2,
    };

    // Get risk for a specific task
    function getRiskForTask(taskId: string): DeadlineRisk | undefined {
        return risks.find((r) => r.taskId === taskId);
    }

    // Sort: critical first, then important, then nice-to-have, then by deadline
    const sortedTasks = [...tasks].sort((a, b) => {
        // Completed tasks at the end
        if (a.status === "completed" && b.status !== "completed") {
            return 1;
        }
        if (a.status !== "completed" && b.status === "completed") {
            return -1;
        }

        // Urgency order
        const urgencyDiff = urgencyOrder[a.urgencyLevel] - urgencyOrder[b.urgencyLevel];
        if (urgencyDiff !== 0) {
            return urgencyDiff;
        }

        // Deadline (earlier first, no deadline last)
        if (a.deadline && b.deadline) {
            return new Date(a.deadline).getTime() - new Date(b.deadline).getTime();
        }
        if (a.deadline) {
            return -1;
        }
        if (b.deadline) {
            return 1;
        }

        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });

    return (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 auto-rows-fr">
            {sortedTasks.map((task, index) => {
                const risk = getRiskForTask(task.id);
                return (
                    <AnimatedCard key={task.id} index={index}>
                        <TaskCard
                            task={task}
                            riskLevel={risk?.riskLevel}
                            daysLate={risk?.daysLate}
                            onRiskClick={onRiskClick}
                            onComplete={onComplete}
                            className="h-full"
                        />
                    </AnimatedCard>
                );
            })}
        </div>
    );
}

/**
 * Empty state component
 */
function TasksEmptyState({ onAddTask }: { onAddTask: () => void }) {
    return (
        <SharedEmptyState
            icon={ListTodo}
            title="No tasks yet"
            description="Create your first task to get started with the Kanban board. Drag tasks between columns to update their status."
            cta={
                <Button onClick={onAddTask} size="lg" variant="brand" className="gap-3">
                    <Plus className="h-5 w-5" />
                    Create your first task
                </Button>
            }
        />
    );
}
