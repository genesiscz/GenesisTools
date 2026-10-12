import { computeNextRunAt, type ParsedInterval, parseInterval } from "./interval";
import type { DaemonTask, MissedRunPolicy, RunReason, TaskPriority, TaskState } from "./types";

/** A time-of-day run that starts more than this after its slot was missed. The loop ticks at least once a minute,
 *  and its timers fired 15 to 80 s late under load (2026-10-10), so anything later was asleep or down. */
export const MISSED_GRACE_MS = 10 * 60_000;

/** How often an `on-wake` catch-up checks again for a full wake. */
export const WAKE_RECHECK_MS = 60_000;

/** Start order among tasks due in the same tick. */
export const PRIORITY_RANK: Record<TaskPriority, number> = { high: 0, normal: 1, low: 2 };

const HHMM = /^(\d{1,2}):(\d{2})$/;

export function priorityOf(task: DaemonTask): TaskPriority {
    return task.priority ?? "normal";
}

export function missedRunOf(task: DaemonTask): MissedRunPolicy {
    return task.missedRun ?? { mode: "asap" };
}

/** `HH:MM` on the local day of `on`, or null for a malformed time. */
export function timeOnDay(hhmm: string, on: Date): Date | null {
    const match = HHMM.exec(hhmm.trim());
    if (match === null) {
        return null;
    }

    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) {
        return null;
    }

    const at = new Date(on);
    at.setHours(hour, minute, 0, 0);
    return at;
}

/** The `retry-at` times of the local day of `now` that are still ahead of it, earliest first, as epoch ms. */
export function retryTimesAhead(policy: MissedRunPolicy, now: Date): number[] {
    return (policy.times ?? [])
        .map((time) => timeOnDay(time, now)?.getTime())
        .filter((ms): ms is number => ms !== undefined && ms > now.getTime())
        .sort((a, b) => a - b);
}

/** The latest regular slot at or before `now` of a time-of-day schedule. */
export function latestSlotAtOrBefore(parsed: ParsedInterval, now: Date): Date {
    const slot = new Date(now);
    slot.setHours(parsed.atHour ?? 0, parsed.atMinute ?? 0, 0, 0);

    if (slot > now) {
        slot.setDate(slot.getDate() - 1);
    }

    return slot;
}

export type DuePlan =
    | { action: "run"; reason: RunReason; priority: TaskPriority; scheduledFor?: Date }
    | { action: "defer"; until: Date; reason: RunReason; retryQueue?: number[]; why: string }
    | { action: "skip"; next: Date; why: string };

/**
 * What to do with a task whose `nextRunAt` has come. Interval tasks always run. A time-of-day task runs as
 * scheduled when it is on time; a slot missed by more than `MISSED_GRACE_MS` follows the task's missed-run policy.
 * `fullWake` says the Mac is fully awake (not in a DarkWake); only an `on-wake` catch-up waits for it.
 */
export function planDueRun(input: { task: DaemonTask; state: TaskState; now: Date; fullWake: boolean }): DuePlan {
    const { task, state, now, fullWake } = input;
    const priority = priorityOf(task);
    let parsed: ParsedInterval;

    try {
        parsed = parseInterval(task.every);
    } catch {
        // The scheduler reports a malformed interval when it computes the next run.
        return { action: "run", reason: "scheduled", priority };
    }

    if (!parsed.isTimeOfDay) {
        return { action: "run", reason: "scheduled", priority };
    }

    const slot = state.slotAt ?? state.nextRunAt;
    const policy = missedRunOf(task);
    const reason = state.reason ?? "scheduled";

    if (reason === "retry") {
        return { action: "run", reason, priority, scheduledFor: slot };
    }

    if (reason === "scheduled" && now.getTime() - slot.getTime() <= MISSED_GRACE_MS) {
        return { action: "run", reason, priority, scheduledFor: slot };
    }

    // A missed slot, or a catch-up that was waiting and is due now.
    switch (policy.mode) {
        case "skip":
            return {
                action: "skip",
                next: computeNextRunAt(parsed, now),
                why: `missed ${slot.toISOString()}; the policy skips missed runs`,
            };
        case "on-wake":
            if (!fullWake) {
                return {
                    action: "defer",
                    until: new Date(now.getTime() + WAKE_RECHECK_MS),
                    reason: "catch-up",
                    why: "waiting for a full wake (this is a DarkWake or the display is asleep)",
                };
            }

            return { action: "run", reason: "catch-up", priority: "low", scheduledFor: slot };
        case "retry-at": {
            if (reason === "catch-up") {
                return { action: "run", reason, priority, scheduledFor: slot };
            }

            const ahead = retryTimesAhead(policy, now);
            const first = ahead[0];
            if (first === undefined) {
                return { action: "run", reason: "catch-up", priority, scheduledFor: slot };
            }

            return {
                action: "defer",
                until: new Date(first),
                reason: "catch-up",
                retryQueue: ahead.slice(1),
                why: `missed ${slot.toISOString()}; the policy runs it at ${new Date(first).toISOString()}`,
            };
        }
        default:
            return { action: "run", reason: "catch-up", priority, scheduledFor: slot };
    }
}

/** When a time-of-day task runs next after a run: a `retry-at` retry when the run failed and a retry time is still
 *  ahead, otherwise the next regular slot after both the run's slot and now. */
export function planAfterRun(input: { task: DaemonTask; state: TaskState; ok: boolean; now: Date }): {
    nextRunAt: Date;
    reason: RunReason;
    slotAt: Date;
    retryQueue?: number[];
} {
    const { task, state, ok, now } = input;
    const parsed = parseInterval(task.every);
    const slot = state.slotAt ?? state.nextRunAt;
    const policy = missedRunOf(task);

    if (!ok && policy.mode === "retry-at") {
        const queue = (state.retryQueue ?? retryTimesAhead(policy, now)).filter((ms) => ms > now.getTime());
        const next = queue[0];

        if (next !== undefined) {
            return { nextRunAt: new Date(next), reason: "retry", slotAt: slot, retryQueue: queue.slice(1) };
        }
    }

    const next = computeNextRunAt(parsed, slot > now ? slot : now);
    return { nextRunAt: next, reason: "scheduled", slotAt: next };
}
