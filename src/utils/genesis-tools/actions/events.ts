/**
 * The in-process bus of area events (`ctx.emit`). Phase 2's service forwards each event as `<area>.<event>`; until
 * then a listener in the same process (and a test) observes them here.
 */
export interface AreaEvent {
    area: string;
    event: string;
    payload: unknown;
    at: string;
}

export interface AreaEventBus {
    emit(event: AreaEvent): void;
    on(listener: (event: AreaEvent) => void): () => void;
}

export function createAreaEventBus(): AreaEventBus {
    const listeners = new Set<(event: AreaEvent) => void>();

    return {
        emit(event) {
            for (const listener of listeners) {
                listener(event);
            }
        },
        on(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
}

/** The service event name of an area event. */
export function areaEventName(area: string, event: string): `${string}.${string}` {
    return `${area}.${event}`;
}
