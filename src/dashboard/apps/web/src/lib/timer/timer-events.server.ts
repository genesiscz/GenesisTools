/**
 * Timer SSE compat layer — delegates to the generic domain bus
 * (src/lib/events/event-bus.server.ts) with domain="timer".
 *
 * Kept as a thin shim so existing timer call sites (timer-sync.server.ts)
 * and the /api/timer-events route need ZERO changes while timer events now
 * also flow through the shared bus that /api/events exposes.
 */

import { type DomainEvent, emitDomainEvent, subscribeEvents } from "@/lib/events/event-bus.server";

export interface TimerEvent {
    type: string;
    timerId?: string;
    snapshot?: unknown;
    payload?: unknown;
}

/**
 * Subscribe to timer events for a user.
 * Returns an unsubscribe function — call it when the SSE connection closes.
 */
export function subscribeTimerEvents(userId: string, listener: (event: TimerEvent) => void): () => void {
    return subscribeEvents(userId, (event: DomainEvent) => {
        if (event.domain !== "timer") {
            return;
        }

        listener({
            type: event.type,
            timerId: typeof event.timerId === "string" ? event.timerId : undefined,
            snapshot: event.snapshot,
            payload: event.payload,
        });
    });
}

/**
 * Emit a timer event for a user (called from server mutations).
 */
export function emitTimerEvent(userId: string, event: TimerEvent): void {
    emitDomainEvent(userId, "timer", event);
}
