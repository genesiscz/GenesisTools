import { SafeJSON } from "@dashboard/shared";
import { useEffect, useRef } from "react";

export interface ServerEvent {
    domain: string;
    type: string;
    [key: string]: unknown;
}

interface UseServerEventsOptions {
    userId: string | null;
    domain: string;
    onEvent: (event: ServerEvent) => void;
}

/**
 * Subscribe to server-sent events for a user, filtered to one domain.
 *
 * Generic transport — domain-specific cache handling lives in the caller's
 * `onEvent`. Reconnects automatically (browser EventSource behaviour).
 * Only mounts when userId is provided (no-auth dev fallback passes "dev-user").
 *
 * `onEvent` is held in a ref so an inline callback does NOT retrigger the
 * effect and churn the EventSource connection every render.
 */
export function useServerEvents({ userId, domain, onEvent }: UseServerEventsOptions) {
    const onEventRef = useRef(onEvent);
    onEventRef.current = onEvent;

    useEffect(() => {
        if (!userId) {
            return;
        }

        if (typeof EventSource === "undefined") {
            return; // SSR guard
        }

        const es = new EventSource(
            `/api/events?userId=${encodeURIComponent(userId)}&domain=${encodeURIComponent(domain)}`
        );

        es.onmessage = (msg) => {
            try {
                const event = SafeJSON.parse<ServerEvent>(msg.data);
                onEventRef.current(event);
            } catch {
                // malformed event — ignore
            }
        };

        es.onerror = () => {
            // EventSource auto-reconnects — nothing to do here
        };

        return () => {
            es.close();
        };
    }, [userId, domain]);
}
