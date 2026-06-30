import { useDraggable, useDroppable } from "@dnd-kit/core";
import { useNavigate } from "@tanstack/react-router";
import type { AssistantTask } from "@/drizzle";
import { INBOX_DROPPABLE_ID } from "./usePlannerDnd";

// Static urgency badge colours (no dynamic Tailwind interpolation)
const URGENCY_BADGE_BG: Record<string, string> = {
    critical: "bg-red-900/70 text-red-300 border-red-700",
    important: "bg-orange-900/70 text-orange-300 border-orange-700",
    "nice-to-have": "bg-yellow-900/70 text-yellow-300 border-yellow-700",
};

const URGENCY_LABEL: Record<string, string> = {
    critical: "critical",
    important: "important",
    "nice-to-have": "nice",
};

interface DraggableInboxItemProps {
    task: AssistantTask;
    onFocus: (id: string) => void;
}

function DraggableInboxItem({ task, onFocus }: DraggableInboxItemProps) {
    const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: task.id });
    const urgency = task.urgencyLevel ?? "nice-to-have";
    const badgeCls = URGENCY_BADGE_BG[urgency] ?? URGENCY_BADGE_BG["nice-to-have"];
    const badgeLabel = URGENCY_LABEL[urgency] ?? urgency;

    return (
        <div
            ref={setNodeRef}
            {...listeners}
            {...attributes}
            data-testid="planner-inbox-item"
            data-task-id={task.id}
            className={[
                "group flex cursor-grab items-center gap-2 rounded-lg border border-white/5 bg-zinc-800/60 px-3 py-2",
                "transition-all duration-150 hover:border-white/10 hover:bg-zinc-800/80 hover:shadow-md",
                isDragging ? "opacity-40" : "",
            ].join(" ")}
        >
            <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-zinc-100">{task.title}</p>
                {task.deadline && (
                    <p className="text-[10px] text-zinc-500" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                        due {new Date(task.deadline).toLocaleDateString()}
                    </p>
                )}
            </div>
            <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-semibold ${badgeCls}`}>
                {badgeLabel}
            </span>
            <button
                type="button"
                onClick={(e) => {
                    e.stopPropagation();
                    onFocus(task.id);
                }}
                className={[
                    "shrink-0 rounded px-2 py-0.5 text-[10px] font-medium",
                    "bg-white/10 text-zinc-400 opacity-0 transition-opacity group-hover:opacity-100",
                    "hover:bg-white/20 hover:text-white",
                ].join(" ")}
            >
                Focus →
            </button>
        </div>
    );
}

interface PlannerInboxProps {
    tasks: AssistantTask[];
    completedToday: number;
    deferredToTomorrow: number;
}

export function PlannerInbox({ tasks, completedToday, deferredToTomorrow }: PlannerInboxProps) {
    const navigate = useNavigate();
    const { setNodeRef, isOver } = useDroppable({ id: INBOX_DROPPABLE_ID });

    function handleFocus(taskId: string) {
        navigate({ to: "/dashboard/focus", search: { taskId } });
    }

    return (
        <div
            ref={setNodeRef}
            data-testid="planner-inbox"
            className={[
                "flex w-full shrink-0 flex-col gap-2 rounded-xl border bg-zinc-900/60 p-3 backdrop-blur-sm md:w-72",
                "transition-colors duration-150",
                isOver ? "border-amber-400/60 bg-amber-400/5 ring-1 ring-amber-400/30" : "border-white/5",
            ].join(" ")}
        >
            <div className="flex items-center justify-between px-1">
                <h3 className="text-xs font-semibold uppercase tracking-widest text-zinc-400">Inbox</h3>
                <span className="text-[10px] text-zinc-600" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                    {tasks.length} task{tasks.length !== 1 ? "s" : ""}
                </span>
            </div>

            {tasks.length === 0 ? (
                <p
                    data-testid="planner-inbox-empty"
                    className={[
                        "rounded-lg border border-dashed px-1 py-6 text-center text-xs transition-colors",
                        isOver ? "border-amber-400/60 text-amber-300" : "border-white/10 text-zinc-600",
                    ].join(" ")}
                >
                    {isOver
                        ? "Drop here to move back to the inbox"
                        : "Inbox empty — drag on the timeline to create a task"}
                </p>
            ) : (
                <div className="flex flex-col gap-1.5 overflow-y-auto">
                    {tasks.map((task) => (
                        <DraggableInboxItem key={task.id} task={task} onFocus={handleFocus} />
                    ))}
                </div>
            )}

            <p className="mt-1 px-1 text-[10px] text-zinc-600">
                Drag on empty timeline space to create a task, or drag a scheduled block here to unschedule it.
            </p>

            {/* Footer stats */}
            <div className="mt-2 grid grid-cols-2 gap-1.5">
                <div className="flex flex-col items-center rounded-lg border border-white/5 bg-zinc-800/60 py-2 px-1">
                    <span
                        className="text-lg font-bold text-emerald-400"
                        style={{ fontFamily: "'JetBrains Mono', monospace" }}
                    >
                        {completedToday}
                    </span>
                    <span className="text-[9px] uppercase tracking-widest text-zinc-500">done today</span>
                </div>
                <div className="flex flex-col items-center rounded-lg border border-white/5 bg-zinc-800/60 py-2 px-1">
                    <span
                        className="text-lg font-bold text-amber-400"
                        style={{ fontFamily: "'JetBrains Mono', monospace" }}
                    >
                        {deferredToTomorrow}
                    </span>
                    <span className="text-[9px] uppercase tracking-widest text-zinc-500">for tomorrow</span>
                </div>
            </div>
        </div>
    );
}
