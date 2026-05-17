import { useDroppable } from "@dnd-kit/core";
import { useState } from "react";
import type { FocusSessionBlock } from "@/lib/timer/timer-sync.server";
import { FocusSessionGhost } from "./FocusSessionGhost";
import { NowMarker } from "./NowMarker";
import { TaskBlock } from "./TaskBlock";
import type { ScheduledTask } from "./usePlannerData";

/** Pixels per hour in the timeline. */
const PX_PER_HOUR = 80;

/** Hours displayed: 06:00–24:00 (18 hours) */
const START_HOUR = 6;
const END_HOUR = 24;
const TOTAL_HOURS = END_HOUR - START_HOUR;
const TIMELINE_HEIGHT = TOTAL_HOURS * PX_PER_HOUR;

const HOUR_LABELS = Array.from({ length: TOTAL_HOURS + 1 }, (_, i) => START_HOUR + i);

function hourToPx(hour: number): number {
    return (hour - START_HOUR) * PX_PER_HOUR;
}

function isoToPx(iso: string): number {
    const d = new Date(iso);
    const fractionalHour = d.getHours() + d.getMinutes() / 60;
    return hourToPx(fractionalHour);
}

function nowTopPx(): number {
    const now = new Date();
    const fractionalHour = now.getHours() + now.getMinutes() / 60;
    const clamped = Math.max(START_HOUR, Math.min(END_HOUR, fractionalHour));
    return hourToPx(clamped);
}

/** Local Y px → fractional hour, clamped and snapped to 15-minute steps. */
function pxToHour(px: number): number {
    const raw = START_HOUR + px / PX_PER_HOUR;
    const clamped = Math.max(START_HOUR, Math.min(END_HOUR, raw));
    return Math.round(clamped * 4) / 4;
}

/** Fractional hour on today's date → ISO datetime. */
function hourToIso(hour: number): string {
    const d = new Date();
    d.setHours(Math.floor(hour), Math.round((hour % 1) * 60), 0, 0);
    return d.toISOString();
}

interface PlannerTimelineProps {
    scheduledTasks: ScheduledTask[];
    /** Active drag task id, from usePlannerDnd */
    activeDragId: string | null;
    dragListeners?: Record<string, unknown>;
    dragAttributes?: Record<string, unknown>;
    /** Completed pomodoro focus sessions to render as ghost blocks */
    focusSessions: FocusSessionBlock[];
    /** Draw a time block on empty timeline space to create a scheduled task. */
    onCreateAt?: (scheduledStart: string, scheduledEnd: string) => void;
}

function DroppableTimeline({
    children,
    onCreateAt,
}: {
    children: React.ReactNode;
    onCreateAt?: (scheduledStart: string, scheduledEnd: string) => void;
}) {
    const { setNodeRef, isOver } = useDroppable({ id: "timeline" });
    const [draw, setDraw] = useState<{ startPx: number; currentPx: number } | null>(null);

    function localY(e: React.PointerEvent<HTMLDivElement>): number {
        const rect = e.currentTarget.getBoundingClientRect();
        return e.clientY - rect.top;
    }

    function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
        // Only the empty background starts a create-gesture; task blocks and
        // markers are absolutely-positioned children, so a pointerdown on them
        // does not match currentTarget and is left to dnd-kit / their handlers.
        if (!onCreateAt || e.target !== e.currentTarget || e.button !== 0) {
            return;
        }

        const y = localY(e);
        setDraw({ startPx: y, currentPx: y });
        e.currentTarget.setPointerCapture(e.pointerId);
    }

    function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
        if (!draw) {
            return;
        }

        setDraw({ startPx: draw.startPx, currentPx: localY(e) });
    }

    function handlePointerUp() {
        if (!draw || !onCreateAt) {
            setDraw(null);
            return;
        }

        const a = pxToHour(Math.min(draw.startPx, draw.currentPx));
        const b = pxToHour(Math.max(draw.startPx, draw.currentPx));
        // A click (no meaningful drag) defaults to a 1-hour block.
        const startHour = a;
        const endHour = b - a < 0.25 ? Math.min(END_HOUR, a + 1) : b;
        setDraw(null);
        onCreateAt(hourToIso(startHour), hourToIso(endHour));
    }

    const previewTop = draw ? Math.min(draw.startPx, draw.currentPx) : 0;
    const previewHeight = draw ? Math.max(8, Math.abs(draw.currentPx - draw.startPx)) : 0;

    return (
        <div
            ref={setNodeRef}
            className={["relative transition-colors duration-150", isOver ? "bg-white/5" : ""].join(" ")}
            style={{ height: TIMELINE_HEIGHT, touchAction: "pan-y" }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
        >
            {children}
            {draw && (
                <div
                    className="pointer-events-none absolute inset-x-1 z-10 rounded-md border border-amber-400/60 bg-amber-400/15"
                    style={{ top: previewTop, height: previewHeight }}
                />
            )}
        </div>
    );
}

export function PlannerTimeline({ scheduledTasks, activeDragId, focusSessions, onCreateAt }: PlannerTimelineProps) {
    const topPx = nowTopPx();

    return (
        <div className="relative flex-1 overflow-y-auto rounded-xl border border-white/5 bg-zinc-900/50 backdrop-blur-sm">
            <div className="flex">
                {/* Hour labels column */}
                <div
                    className="shrink-0 select-none border-r border-white/5"
                    style={{ width: 56, height: TIMELINE_HEIGHT }}
                >
                    {HOUR_LABELS.map((h) => (
                        <div
                            key={h}
                            className="absolute flex items-center justify-end pr-2 text-zinc-500"
                            style={{
                                top: hourToPx(h) - 9,
                                left: 0,
                                width: 56,
                                fontFamily: "'JetBrains Mono', monospace",
                                fontSize: 10,
                            }}
                        >
                            {h < 10 ? `0${h}:00` : `${h}:00`}
                        </div>
                    ))}
                </div>

                {/* Timeline area */}
                <div className="relative flex-1">
                    {/* Horizontal grid lines */}
                    {HOUR_LABELS.map((h) => (
                        <div
                            key={h}
                            className="pointer-events-none absolute inset-x-0 border-t border-white/5"
                            style={{ top: hourToPx(h) }}
                        />
                    ))}

                    <DroppableTimeline onCreateAt={onCreateAt}>
                        {/* Now marker */}
                        <NowMarker topPx={topPx} />

                        {/* Focus session ghost blocks (completed pomodoros) */}
                        {focusSessions.map((session) => {
                            const blockTopPx = isoToPx(session.startIso);
                            const blockEndPx = isoToPx(session.endIso);
                            const blockHeightPx = Math.max(14, blockEndPx - blockTopPx);
                            return (
                                <FocusSessionGhost
                                    key={`${session.timerId}-${session.startIso}`}
                                    session={session}
                                    topPx={blockTopPx}
                                    heightPx={blockHeightPx}
                                />
                            );
                        })}

                        {/* Scheduled task blocks */}
                        {scheduledTasks.map((task) => {
                            const blockTopPx = isoToPx(task.scheduledStart);
                            const blockEndPx = isoToPx(task.scheduledEnd);
                            const blockHeightPx = Math.max(28, blockEndPx - blockTopPx);

                            return (
                                <TaskBlock
                                    key={task.id}
                                    task={task}
                                    topPx={blockTopPx}
                                    heightPx={blockHeightPx}
                                    isDragging={activeDragId === task.id}
                                />
                            );
                        })}
                    </DroppableTimeline>
                </div>
            </div>
        </div>
    );
}
