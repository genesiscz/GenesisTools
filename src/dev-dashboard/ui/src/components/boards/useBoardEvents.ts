import { paths } from "@app/dev-dashboard/contract/endpoints";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

/** Coarse P0 strategy: every SSE event invalidates ["board", slug] — correct but not
 * granular. A per-event-type cache patch is explicitly out of P0 scope (see plan §Task 25). */
export function useBoardEvents(slug: string): { live: boolean } {
    const [live, setLive] = useState(false);
    const qc = useQueryClient();

    useEffect(() => {
        let es: EventSource | null = null;
        let retry: ReturnType<typeof setTimeout> | null = null;
        let closed = false;

        const connect = () => {
            es = new EventSource(paths.boardEvents(slug));
            es.onopen = () => {
                setLive(true);
                // Full refetch on (re)connect — recovers any gap missed while disconnected.
                void qc.invalidateQueries({ queryKey: ["board", slug] });
            };
            es.onmessage = () => {
                void qc.invalidateQueries({ queryKey: ["board", slug] });
            };
            es.onerror = () => {
                setLive(false);
                es?.close();

                if (!closed) {
                    retry = setTimeout(connect, 2000);
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
