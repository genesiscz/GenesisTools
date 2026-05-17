import { useNavigate } from "@tanstack/react-router";
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
    /** Drag listeners / attributes injected by @dnd-kit. */
    dragListeners?: Record<string, unknown>;
    dragAttributes?: Record<string, unknown>;
    isDragging?: boolean;
}

function formatTime(iso: string): string {
    const d = new Date(iso);
    const h = d.getHours().toString().padStart(2, "0");
    const m = d.getMinutes().toString().padStart(2, "0");
    return `${h}:${m}`;
}

export function TaskBlock({ task, topPx, heightPx, dragListeners, dragAttributes, isDragging }: TaskBlockProps) {
    const navigate = useNavigate();
    const urgency = task.urgencyLevel ?? "nice-to-have";

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
            className={[
                "absolute inset-x-1 overflow-hidden rounded-md border-l-2 px-2 py-1 backdrop-blur-sm",
                "cursor-grab select-none transition-all duration-150",
                "hover:-translate-y-px hover:shadow-lg hover:shadow-black/40",
                bg,
                border,
                isDragging ? "opacity-50 shadow-xl ring-1 ring-white/20" : "",
            ].join(" ")}
            style={{ top: `${topPx}px`, height: `${heightPx}px` }}
            {...(dragListeners ?? {})}
            {...(dragAttributes ?? {})}
        >
            <div className="flex items-start gap-1.5">
                <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
                <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-semibold leading-tight text-zinc-100">{task.title}</p>
                    {heightPx >= 48 && (
                        <p
                            className={`font-mono text-[10px] leading-tight ${labelColor}`}
                            style={{ fontFamily: "'JetBrains Mono', monospace" }}
                        >
                            {formatTime(task.scheduledStart)} – {formatTime(task.scheduledEnd)}
                        </p>
                    )}
                </div>
            </div>
            {heightPx >= 64 && (
                <button
                    type="button"
                    onClick={handleFocus}
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
