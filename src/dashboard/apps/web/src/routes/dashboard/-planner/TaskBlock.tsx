import { useDraggable } from "@dnd-kit/core";
import { useNavigate } from "@tanstack/react-router";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { CalendarClock, Check, MoreVertical, Pencil, RotateCcw, Trash2 } from "lucide-react";
import type { AssistantTask } from "@/drizzle";

// Static lookup — never use bg-${x} Tailwind interpolation (JIT purges it)
const URGENCY_BORDER: Record<string, string> = {
    critical: "border-red-500",
    important: "border-orange-400",
    "nice-to-have": "border-yellow-400",
    done: "border-zinc-600",
};

const URGENCY_BG: Record<string, string> = {
    critical: "bg-red-950/70",
    important: "bg-orange-950/70",
    "nice-to-have": "bg-yellow-950/70",
    done: "bg-zinc-900/70",
};

const URGENCY_LABEL_COLOR: Record<string, string> = {
    critical: "text-red-400",
    important: "text-orange-400",
    "nice-to-have": "text-yellow-400",
    done: "text-zinc-500",
};

const URGENCY_DOT: Record<string, string> = {
    critical: "bg-red-400",
    important: "bg-orange-400",
    "nice-to-have": "bg-yellow-400",
    done: "bg-zinc-500",
};

interface TaskBlockProps {
    task: AssistantTask & { scheduledStart: string; scheduledEnd: string };
    /** Top offset within timeline scroll area (px). */
    topPx: number;
    /** Height of the block (px). */
    heightPx: number;
    isDragging?: boolean;
    onEditTitle: (task: AssistantTask) => void;
    onDelete: (task: AssistantTask) => void;
    onDefer: (task: AssistantTask) => void;
    onToggleComplete: (task: AssistantTask, completed: boolean) => void;
}

function formatTime(iso: string): string {
    const d = new Date(iso);
    const h = d.getHours().toString().padStart(2, "0");
    const m = d.getMinutes().toString().padStart(2, "0");
    return `${h}:${m}`;
}

export function TaskBlock({
    task,
    topPx,
    heightPx,
    isDragging,
    onEditTitle,
    onDelete,
    onDefer,
    onToggleComplete,
}: TaskBlockProps) {
    const navigate = useNavigate();
    const { attributes, listeners, setNodeRef } = useDraggable({ id: task.id });

    const isDone = task.status === "completed";
    const urgency = isDone ? "done" : (task.urgencyLevel ?? "nice-to-have");

    const border = URGENCY_BORDER[urgency] ?? URGENCY_BORDER["nice-to-have"];
    const bg = URGENCY_BG[urgency] ?? URGENCY_BG["nice-to-have"];
    const labelColor = URGENCY_LABEL_COLOR[urgency] ?? URGENCY_LABEL_COLOR["nice-to-have"];
    const dot = URGENCY_DOT[urgency] ?? URGENCY_DOT["nice-to-have"];

    function handleFocus(e: React.MouseEvent) {
        e.stopPropagation();
        navigate({ to: "/dashboard/focus", search: { taskId: task.id } });
    }

    return (
        <div
            ref={setNodeRef}
            data-testid="planner-task-block"
            data-task-id={task.id}
            data-completed={isDone ? "true" : "false"}
            className={[
                "group absolute inset-x-1 overflow-hidden rounded-md border-l-2 px-2 py-1 backdrop-blur-sm",
                "cursor-grab select-none transition-all duration-150",
                "hover:-translate-y-px hover:shadow-lg hover:shadow-black/40",
                bg,
                border,
                isDone ? "opacity-70" : "",
                isDragging ? "opacity-50 shadow-xl ring-1 ring-white/20" : "",
            ].join(" ")}
            style={{ top: `${topPx}px`, height: `${heightPx}px` }}
            {...listeners}
            {...attributes}
        >
            <div className="flex items-start gap-1.5">
                <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
                <div className="min-w-0 flex-1">
                    <p
                        className={[
                            "truncate text-xs font-semibold leading-tight text-zinc-100",
                            isDone ? "line-through text-zinc-400" : "",
                        ].join(" ")}
                    >
                        {task.title}
                    </p>
                    {heightPx >= 48 && (
                        <p
                            className={`font-mono text-[10px] leading-tight ${labelColor}`}
                            style={{ fontFamily: "'JetBrains Mono', monospace" }}
                        >
                            {formatTime(task.scheduledStart)} – {formatTime(task.scheduledEnd)}
                        </p>
                    )}
                </div>

                {/* Inline actions menu (kept out of the drag gesture) */}
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <button
                            type="button"
                            data-testid="planner-task-menu-trigger"
                            aria-label="Task actions"
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => e.stopPropagation()}
                            className={[
                                "-mr-1 -mt-0.5 shrink-0 rounded p-0.5 text-zinc-400 transition-opacity",
                                "opacity-0 hover:bg-white/10 hover:text-white focus:opacity-100 group-hover:opacity-100",
                            ].join(" ")}
                        >
                            <MoreVertical className="h-3.5 w-3.5" />
                        </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                        align="end"
                        className="w-44"
                        onClick={(e) => e.stopPropagation()}
                        onPointerDown={(e) => e.stopPropagation()}
                    >
                        <DropdownMenuItem
                            data-testid="planner-task-toggle-complete"
                            onSelect={() => onToggleComplete(task, !isDone)}
                        >
                            {isDone ? <RotateCcw className="h-4 w-4" /> : <Check className="h-4 w-4" />}
                            {isDone ? "Mark incomplete" : "Mark complete"}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                            data-testid="planner-task-edit-title"
                            onSelect={() => onEditTitle(task)}
                        >
                            <Pencil className="h-4 w-4" />
                            Edit title
                        </DropdownMenuItem>
                        <DropdownMenuItem
                            data-testid="planner-task-defer"
                            onSelect={() => onDefer(task)}
                        >
                            <CalendarClock className="h-4 w-4" />
                            Defer to tomorrow
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                            data-testid="planner-task-delete"
                            variant="destructive"
                            onSelect={() => onDelete(task)}
                        >
                            <Trash2 className="h-4 w-4" />
                            Delete task
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>

            {heightPx >= 64 && !isDone && (
                <button
                    type="button"
                    onClick={handleFocus}
                    onPointerDown={(e) => e.stopPropagation()}
                    className={[
                        "mt-1 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors",
                        "bg-white/10 text-zinc-300 hover:bg-white/20 hover:text-white",
                    ].join(" ")}
                >
                    Focus →
                </button>
            )}
        </div>
    );
}
