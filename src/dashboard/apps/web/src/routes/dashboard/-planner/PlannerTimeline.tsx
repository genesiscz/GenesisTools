import { useDroppable } from "@dnd-kit/core";
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

interface PlannerTimelineProps {
    scheduledTasks: ScheduledTask[];
    /** Active drag task id, from usePlannerDnd */
    activeDragId: string | null;
    dragListeners?: Record<string, unknown>;
    dragAttributes?: Record<string, unknown>;
    /** Completed pomodoro focus sessions to render as ghost blocks */
    focusSessions: FocusSessionBlock[];
}

function DroppableTimeline({ children }: { children: React.ReactNode }) {
    const { setNodeRef, isOver } = useDroppable({ id: "timeline" });

    return (
        <div
            ref={setNodeRef}
            className={["relative transition-colors duration-150", isOver ? "bg-white/5" : ""].join(" ")}
            style={{ height: TIMELINE_HEIGHT }}
        >
            {children}
        </div>
    );
}

export function PlannerTimeline({ scheduledTasks, activeDragId, focusSessions }: PlannerTimelineProps) {
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

                    <DroppableTimeline>
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
