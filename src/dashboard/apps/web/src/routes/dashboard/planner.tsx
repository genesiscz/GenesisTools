import { DndContext, DragOverlay } from "@dnd-kit/core";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { DashboardLayout } from "@/components/dashboard";
import { useBroadcastInvalidation, ASSISTANT_SYNC_CHANNEL } from "@/lib/sync/useBroadcastInvalidation";
import { PlannerHeader } from "./-planner/PlannerHeader";
import { PlannerInbox } from "./-planner/PlannerInbox";
import { PlannerTimeline } from "./-planner/PlannerTimeline";
import { usePlannerData } from "./-planner/usePlannerData";
import { usePlannerDnd } from "./-planner/usePlannerDnd";
import type { PlannerView } from "./-planner/PlannerHeader";

export const Route = createFileRoute("/dashboard/planner")({
    component: DailyPlannerPage,
});

function DailyPlannerPage() {
    return (
        <DashboardLayout
            title="Daily Planner"
            description="Block your day and keep tasks on track"
        >
            <PlannerRoot />
        </DashboardLayout>
    );
}

function PlannerRoot() {
    useBroadcastInvalidation(ASSISTANT_SYNC_CHANNEL);

    const [view, setView] = useState<PlannerView>("day");
    const navigate = useNavigate();

    const { scheduledTasks, unscheduledTasks, allActiveTasks, scheduleTask, isLoading, error } = usePlannerData();

    const { activeDragId, sensors, handleDragStart, handleDragEnd } = usePlannerDnd({
        onSchedule: scheduleTask,
        getTaskSchedule: (id) => {
            const t = scheduledTasks.find((s) => s.id === id) ?? unscheduledTasks.find((u) => u.id === id);
            return t ? { scheduledStart: t.scheduledStart ?? null, scheduledEnd: t.scheduledEnd ?? null } : undefined;
        },
    });

    if (isLoading) {
        return (
            <div className="flex h-64 items-center justify-center">
                <p className="text-sm text-zinc-500">Loading planner…</p>
            </div>
        );
    }

    if (error) {
        return (
            <div className="flex h-64 items-center justify-center">
                <p className="text-sm text-red-400">Failed to load tasks.</p>
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-3">
            <PlannerHeader
                view={view}
                onViewChange={setView}
                scheduledCount={scheduledTasks.length}
                inboxCount={unscheduledTasks.length}
            />

            {view === "day" ? (
                <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
                    <div className="flex gap-3" style={{ minHeight: "calc(100vh - 220px)" }}>
                        <PlannerTimeline
                            scheduledTasks={scheduledTasks}
                            activeDragId={activeDragId}
                        />
                        <PlannerInbox tasks={unscheduledTasks} />
                    </div>

                    {/* Drag overlay: ghost of active dragged item */}
                    <DragOverlay>
                        {activeDragId ? (
                            <div className="w-64 rounded-lg border border-white/20 bg-zinc-800/90 px-3 py-2 text-sm text-zinc-100 shadow-xl backdrop-blur-sm">
                                {allActiveTasks.find((t) => t.id === activeDragId)?.title ?? "Task"}
                            </div>
                        ) : null}
                    </DragOverlay>
                </DndContext>
            ) : (
                <PlannerListView
                    tasks={allActiveTasks}
                    onFocus={(id) => navigate({ to: "/dashboard/focus", search: { taskId: id } })}
                />
            )}
        </div>
    );
}

// ─── List View ───────────────────────────────────────────────────────────────

const URGENCY_ROW_COLOR: Record<string, string> = {
    critical: "border-l-red-500",
    important: "border-l-orange-400",
    "nice-to-have": "border-l-yellow-400",
};

interface PlannerListViewProps {
    tasks: (typeof allActiveTasks)[number][];
    onFocus: (id: string) => void;
}

// biome-ignore lint/suspicious/noShadowRestrictedNames: local alias for type inference
const allActiveTasks: ReturnType<typeof usePlannerData>["allActiveTasks"] = [];

function PlannerListView({ tasks, onFocus }: PlannerListViewProps) {
    return (
        <div className="flex flex-col gap-2">
            {tasks.length === 0 && (
                <p className="py-12 text-center text-sm text-zinc-600">No active tasks.</p>
            )}
            {tasks.map((task) => {
                const urgency = task.urgencyLevel ?? "nice-to-have";
                const borderCls = URGENCY_ROW_COLOR[urgency] ?? URGENCY_ROW_COLOR["nice-to-have"];

                return (
                    <div
                        key={task.id}
                        className={[
                            "group flex items-center gap-3 rounded-xl border-l-2 border-white/5 bg-zinc-900/60 px-4 py-3",
                            "backdrop-blur-sm transition-all hover:bg-zinc-900/80",
                            borderCls,
                        ].join(" ")}
                    >
                        <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium text-zinc-100">{task.title}</p>
                            {task.scheduledStart && (
                                <p
                                    className="text-[10px] text-zinc-500"
                                    style={{ fontFamily: "'JetBrains Mono', monospace" }}
                                >
                                    {new Date(task.scheduledStart).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                                    {task.scheduledEnd &&
                                        ` – ${new Date(task.scheduledEnd).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}
                                </p>
                            )}
                        </div>
                        <button
                            type="button"
                            onClick={() => onFocus(task.id)}
                            className="shrink-0 rounded px-2 py-1 text-xs font-medium text-zinc-400 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-white/10 hover:text-white"
                        >
                            Focus →
                        </button>
                    </div>
                );
            })}
        </div>
    );
}
