import type { BoardEventDto } from "@app/dev-dashboard/contract/dto";
import { paths } from "@app/dev-dashboard/contract/endpoints";
import { SafeJSON } from "@app/utils/json";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

/** Coarse P0 strategy: every SSE event invalidates ["board", slug] — correct but not
 * granular. A per-event-type cache patch is explicitly out of P0 scope (see plan §Task 25).
 * `onEvent` is an additional hook for callers that need a specific event's payload (e.g. the
 * set_version sync banner) — invalidation stays the default behavior regardless. */
export function useBoardEvents(slug: string, onEvent?: (e: BoardEventDto) => void): { live: boolean } {
    const [live, setLive] = useState(false);
    const qc = useQueryClient();
    const onEventRef = useRef(onEvent);
    onEventRef.current = onEvent;

    useEffect(() => {
        let es: EventSource | null = null;
        let retry: ReturnType<typeof setTimeout> | null = null;
        let closed = false;
        let attempt = 0;
        const MAX_RETRY_MS = 30_000;

        const connect = () => {
            es = new EventSource(paths.boardEvents(slug));
            es.onopen = () => {
                setLive(true);
                attempt = 0;
                // Full refetch on (re)connect — recovers any gap missed while disconnected.
                void qc.invalidateQueries({ queryKey: ["board", slug] });
            };
            es.onmessage = (ev) => {
                void qc.invalidateQueries({ queryKey: ["board", slug] });

                try {
                    onEventRef.current?.(SafeJSON.parse(ev.data, { strict: true }) as BoardEventDto);
                } catch (err) {
                    console.warn("[boards] failed to parse SSE frame", err);
                }
            };
            es.onerror = () => {
                setLive(false);
                es?.close();

                if (!closed) {
                    const delay = Math.min(MAX_RETRY_MS, 2000 * 2 ** attempt);
                    attempt += 1;
                    retry = setTimeout(connect, delay);
                }
            };
        };

        connect();

        return () => {
            closed = true;

            if (retry) {
                clearTimeout(retry);
            }

            es?.close();
        };
    }, [slug, qc]);

    return { live };
}
