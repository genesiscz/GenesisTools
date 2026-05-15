/**
 * Server-side SSE event emitter for timer events.
 * Per-user EventEmitter map — server push for real-time cross-tab/device sync.
 *
 * NOTE: in-memory only; events are lost on server restart.
 * EventSource auto-reconnects — clients will re-fetch on reconnect.
 */

import { EventEmitter } from "node:events";

export interface TimerEvent {
    type: string;
    timerId?: string;
    snapshot?: unknown;
    payload?: unknown;
}

const emitters = new Map<string, EventEmitter>();

function getEmitter(userId: string): EventEmitter {
    let e = emitters.get(userId);

    if (!e) {
        e = new EventEmitter();
        e.setMaxListeners(50);
        emitters.set(userId, e);
    }

    return e;
}

/**
 * Subscribe to timer events for a user.
 * Returns an unsubscribe function — call it when the SSE connection closes.
 */
export function subscribeTimerEvents(userId: string, listener: (event: TimerEvent) => void): () => void {
    const e = getEmitter(userId);
    e.on("event", listener);
    return () => e.off("event", listener);
}

/**
 * Emit a timer event for a user (called from server mutations).
 */
export function emitTimerEvent(userId: string, event: TimerEvent): void {
    getEmitter(userId).emit("event", event);
}
