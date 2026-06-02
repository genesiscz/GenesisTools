import { type DragEndEvent, type DragStartEvent, MouseSensor, TouchSensor, useSensor, useSensors } from "@dnd-kit/core";
import { useState } from "react";

/** Pixels per hour in the timeline — must match PlannerTimeline.tsx */
const PX_PER_HOUR = 80;
const START_HOUR = 6;

/**
 * Converts a drop y-offset (pixels from top of timeline) + original task
 * duration to new ISO start/end strings (same day, new time slot).
 */
function offsetToIso(offsetPx: number, durationMs: number, referenceDate: Date): { start: string; end: string } {
    const fractionalHour = START_HOUR + offsetPx / PX_PER_HOUR;
    // Snap to nearest 15-minute slot
    const totalMinutes = Math.round((fractionalHour * 60) / 15) * 15;
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;

    const start = new Date(referenceDate);
    start.setHours(hours, minutes, 0, 0);

    const end = new Date(start.getTime() + durationMs);

    return { start: start.toISOString(), end: end.toISOString() };
}

/** Droppable id of the inbox drop zone — dropping a scheduled block here unschedules it. */
export const INBOX_DROPPABLE_ID = "inbox";

interface UsePlannerDndOptions {
    onSchedule: (taskId: string, start: string, end: string) => Promise<unknown>;
    onUnschedule: (taskId: string) => Promise<unknown>;
    getTaskSchedule: (taskId: string) => { scheduledStart: string | null; scheduledEnd: string | null } | undefined;
}

export function usePlannerDnd({ onSchedule, onUnschedule, getTaskSchedule }: UsePlannerDndOptions) {
    const [activeDragId, setActiveDragId] = useState<string | null>(null);

    const sensors = useSensors(
        useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
        useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } })
    );

    function handleDragStart(event: DragStartEvent) {
        setActiveDragId(String(event.active.id));
    }

    function handleDragEnd(event: DragEndEvent) {
        setActiveDragId(null);

        const { active, delta, over } = event;
        if (!over) {
            return;
        }

        const taskId = String(active.id);
        const schedule = getTaskSchedule(taskId);
        if (!schedule?.scheduledStart || !schedule.scheduledEnd) {
            return;
        }

        // Dropping a scheduled block onto the inbox unschedules it (clears its
        // time) instead of repositioning it on the timeline.
        if (over.id === INBOX_DROPPABLE_ID) {
            onUnschedule(taskId).catch((err) => {
                console.error("[PlannerDnd] unschedule failed", err);
            });
            return;
        }

        const durationMs = new Date(schedule.scheduledEnd).getTime() - new Date(schedule.scheduledStart).getTime();
        const originalTopPx =
            (new Date(schedule.scheduledStart).getHours() +
                new Date(schedule.scheduledStart).getMinutes() / 60 -
                START_HOUR) *
            PX_PER_HOUR;

        const newTopPx = Math.max(0, originalTopPx + delta.y);
        const referenceDate = new Date(schedule.scheduledStart);
        const { start, end } = offsetToIso(newTopPx, durationMs, referenceDate);

        onSchedule(taskId, start, end).catch((err) => {
            console.error("[PlannerDnd] reschedule failed", err);
        });
    }

    return { activeDragId, sensors, handleDragStart, handleDragEnd };
}
