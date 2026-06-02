import type { EventSourceLike } from "@dd/contract";
import { parseSseFrame } from "@/lib/sse-frame";
import { fetch as expoFetch } from "expo/fetch";

export { parseSseFrame };

/** Minimal EventSource-like over expo/fetch streaming + the SSE frame parser. */
export function makeExpoEventSource(url: string, authHeader: string | null): EventSourceLike {
    const controller = new AbortController();
    const es: EventSourceLike = { close: () => controller.abort(), onmessage: null, onerror: null };

    (async () => {
        try {
            const res = await expoFetch(url, {
                headers: {
                    Accept: "text/event-stream",
                    ...(authHeader ? { Authorization: authHeader } : {}),
                },
                signal: controller.signal,
            });

            if (!res.body) {
                throw new Error(`SSE stream has no body: ${url}`);
            }

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";

            for (;;) {
                const { value, done } = await reader.read();

                if (done) {
                    break;
                }

                buffer += decoder.decode(value, { stream: true });
                let idx = buffer.indexOf("\n\n");

                while (idx !== -1) {
                    const frame = buffer.slice(0, idx);
                    buffer = buffer.slice(idx + 2);
                    const data = parseSseFrame(frame);

                    if (data !== null && es.onmessage) {
                        es.onmessage({ data });
                    }

                    idx = buffer.indexOf("\n\n");
                }
            }
        } catch (err) {
            es.onerror?.(err);
        }
    })();

    return es;
}
