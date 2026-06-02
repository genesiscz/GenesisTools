// Hermes (React Native's JS engine) has no DOM `Event` / `EventTarget` globals. `partysocket`
// (the ReconnectingWebSocket behind the terminal transport) defines `CloseEvent`/`ErrorEvent`
// that `extends Event` at module-eval time, so without these globals the app red-boxes at startup
// with "Property 'Event' doesn't exist" before any screen renders. This installs a minimal,
// spec-shaped polyfill — guarded so it never clobbers a real implementation (e.g. a future RN that
// ships these natively). Must be imported BEFORE any module that touches partysocket (see index.js).

type ListenerEntry = {
    listener: EventListenerOrEventListenerObject;
    once: boolean;
};

interface PolyfillGlobal {
    Event?: unknown;
    EventTarget?: unknown;
    CloseEvent?: unknown;
    ErrorEvent?: unknown;
    MessageEvent?: unknown;
}

const g = globalThis as unknown as PolyfillGlobal;

if (typeof g.Event === "undefined") {
    class EventPolyfill {
        readonly type: string;
        readonly bubbles: boolean;
        readonly cancelable: boolean;
        readonly timeStamp: number;
        defaultPrevented = false;
        target: unknown = null;
        currentTarget: unknown = null;

        constructor(type: string, options?: { bubbles?: boolean; cancelable?: boolean }) {
            this.type = type;
            this.bubbles = options?.bubbles ?? false;
            this.cancelable = options?.cancelable ?? false;
            this.timeStamp = Date.now();
        }

        preventDefault(): void {
            if (this.cancelable) {
                this.defaultPrevented = true;
            }
        }

        stopPropagation(): void {}
        stopImmediatePropagation(): void {}
    }

    g.Event = EventPolyfill;
}

if (typeof g.EventTarget === "undefined") {
    const EventCtor = g.Event as new (type: string) => { type: string; target: unknown; currentTarget: unknown };

    class EventTargetPolyfill {
        private readonly listeners = new Map<string, ListenerEntry[]>();

        addEventListener(
            type: string,
            listener: EventListenerOrEventListenerObject | null,
            options?: boolean | { once?: boolean }
        ): void {
            if (!listener) {
                return;
            }

            const once = typeof options === "object" ? options.once === true : false;
            const entries = this.listeners.get(type) ?? [];
            entries.push({ listener, once });
            this.listeners.set(type, entries);
        }

        removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
            if (!listener) {
                return;
            }

            const entries = this.listeners.get(type);
            if (!entries) {
                return;
            }

            this.listeners.set(
                type,
                entries.filter((e) => e.listener !== listener)
            );
        }

        dispatchEvent(event: { type: string; target?: unknown; currentTarget?: unknown }): boolean {
            const entries = this.listeners.get(event.type);
            if (!entries || entries.length === 0) {
                return true;
            }

            event.target = this;
            event.currentTarget = this;

            for (const entry of [...entries]) {
                const fn =
                    typeof entry.listener === "function"
                        ? entry.listener
                        : entry.listener.handleEvent.bind(entry.listener);
                fn(event as Event);

                if (entry.once) {
                    this.removeEventListener(event.type, entry.listener);
                }
            }

            return true;
        }
    }

    void EventCtor;
    g.EventTarget = EventTargetPolyfill;
}

const BaseEvent = g.Event as new (
    type: string,
    options?: { bubbles?: boolean; cancelable?: boolean }
) => object;

if (typeof g.CloseEvent === "undefined") {
    class CloseEventPolyfill extends BaseEvent {
        readonly code: number;
        readonly reason: string;
        readonly wasClean: boolean;

        constructor(type: string, options?: { code?: number; reason?: string; wasClean?: boolean }) {
            super(type);
            this.code = options?.code ?? 1000;
            this.reason = options?.reason ?? "";
            this.wasClean = options?.wasClean ?? false;
        }
    }

    g.CloseEvent = CloseEventPolyfill;
}

if (typeof g.ErrorEvent === "undefined") {
    class ErrorEventPolyfill extends BaseEvent {
        readonly message: string;
        readonly error: unknown;

        constructor(type: string, options?: { message?: string; error?: unknown }) {
            super(type);
            this.message = options?.message ?? "";
            this.error = options?.error ?? null;
        }
    }

    g.ErrorEvent = ErrorEventPolyfill;
}

if (typeof g.MessageEvent === "undefined") {
    class MessageEventPolyfill extends BaseEvent {
        readonly data: unknown;

        constructor(type: string, options?: { data?: unknown }) {
            super(type);
            this.data = options?.data ?? null;
        }
    }

    g.MessageEvent = MessageEventPolyfill;
}
