import { fetch as expoFetch } from "expo/fetch";

export interface SseEvent {
    event?: string;
    id?: string;
    data: string;
}

/** Pure SSE line framer. Feed raw decoded text via `push`; it emits complete events. */
export class SseFramer {
    private buffer = "";
    private dataLines: string[] = [];
    private eventName: string | undefined;
    private eventId: string | undefined;

    constructor(private readonly onEvent: (event: SseEvent) => void) {}

    push(chunk: string): void {
        this.buffer += chunk;
        let nl = this.buffer.indexOf("\n");

        while (nl !== -1) {
            const line = this.buffer.slice(0, nl).replace(/\r$/, "");
            this.buffer = this.buffer.slice(nl + 1);
            this.handleLine(line);
            nl = this.buffer.indexOf("\n");
        }
    }

    private handleLine(line: string): void {
        if (line === "") {
            this.dispatch();
            return;
        }

        if (line.startsWith(":")) {
            return;
        }

        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");

        if (field === "data") {
            this.dataLines.push(value);
            return;
        }

        if (field === "event") {
            this.eventName = value;
            return;
        }

        if (field === "id") {
            this.eventId = value;
        }
    }

    private dispatch(): void {
        if (this.dataLines.length === 0 && this.eventName === undefined && this.eventId === undefined) {
            return;
        }

        const event: SseEvent = { data: this.dataLines.join("\n") };

        if (this.eventName !== undefined) {
            event.event = this.eventName;
        }

        if (this.eventId !== undefined) {
            event.id = this.eventId;
        }

        this.dataLines = [];
        this.eventName = undefined;
        this.eventId = undefined;
        this.onEvent(event);
    }
}

export interface StreamSseOptions {
    url: string;
    headers?: Record<string, string>;
    onEvent: (event: SseEvent) => void;
    onOpen?: () => void;
    onError?: (err: unknown) => void;
}

export interface SseHandle {
    close: () => void;
}

/** Opens an SSE stream over expo/fetch and frames it. Returns an aborter. */
export function streamSse(opts: StreamSseOptions): SseHandle {
    const controller = new AbortController();

    void (async () => {
        try {
            const res = await expoFetch(opts.url, {
                method: "GET",
                headers: { Accept: "text/event-stream", ...(opts.headers ?? {}) },
                signal: controller.signal,
            });

            if (!res.ok || !res.body) {
                opts.onError?.(new Error(`sse ${opts.url} -> ${res.status}`));
                return;
            }

            opts.onOpen?.();
            const framer = new SseFramer(opts.onEvent);
            const reader = res.body.getReader();
            const decoder = new TextDecoder();

            for (;;) {
                const { value, done } = await reader.read();

                if (done) {
                    break;
                }

                framer.push(decoder.decode(value, { stream: true }));
            }
        } catch (err) {
            if (!controller.signal.aborted) {
                opts.onError?.(err);
            }
        }
    })();

    return { close: () => controller.abort() };
}
