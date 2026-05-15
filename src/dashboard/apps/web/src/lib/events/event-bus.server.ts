/**
 * Server-side SSE event bus — per-user EventEmitter, domain-tagged events.
 *
 * Generalized from the timer-only emitter so every data domain (timer,
 * notes, bookmarks, ai, …) can push real-time cross-tab/device updates
 * through a single transport. One emitter per user; the event carries its
 * `domain` so a single SSE connection can be filtered server-side.
 *
 * In-memory only; events are lost on server restart. EventSource
 * auto-reconnects and clients re-fetch on reconnect.
 */

import { EventEmitter } from "node:events";

export interface DomainEvent {
    domain: string;
    type: string;
    [key: string]: unknown;
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
 * Subscribe to all domain events for a user. Filter by `event.domain` in
 * the listener (or upstream via the `?domain=` query param on /api/events).
 * Returns an unsubscribe function — call it when the SSE connection closes.
 */
export function subscribeEvents(userId: string, listener: (event: DomainEvent) => void): () => void {
    const e = getEmitter(userId);
    e.on("event", listener);
    return () => e.off("event", listener);
}

/**
 * Emit a domain event for a user (called from server mutations).
 */
export function emitDomainEvent(userId: string, domain: string, event: { type: string; [key: string]: unknown }): void {
    getEmitter(userId).emit("event", { ...event, domain } satisfies DomainEvent);
}
