import type { HandoffEventsResponse } from "@app/dev-dashboard/lib/handoff-types";
import { SafeJSON } from "@genesiscz/utils/json";
import { useQuery } from "@tanstack/react-query";

async function fetchJson<T>(url: string): Promise<T> {
    const res = await fetch(url);
    const text = await res.text();

    if (!res.ok) {
        let message = text;

        try {
            const body = SafeJSON.parse(text, { strict: true }) as { error?: string };

            if (typeof body.error === "string") {
                message = body.error;
            }
        } catch (err) {
            console.debug("fetchJson: non-JSON error body", err);
        }

        throw new Error(message || `${res.status}`);
    }

    return SafeJSON.parse(text, { strict: true }) as T;
}

export async function fetchHandoffEvents(input: {
    id: string;
    limit?: number;
    before?: string;
    beforeUid?: string;
}): Promise<HandoffEventsResponse> {
    const params = new URLSearchParams({ id: input.id, limit: String(input.limit ?? 200) });

    if (input.before !== undefined) {
        params.set("before", input.before);
    }

    if (input.beforeUid !== undefined) {
        params.set("beforeUid", input.beforeUid);
    }

    return fetchJson<HandoffEventsResponse>(`/api/handoff/events?${params.toString()}`);
}

/** First page of a handoff's activity trace; ActivityPanel pages further back via `fetchHandoffEvents`. */
export function useHandoffEvents(id: string | null) {
    return useQuery({
        queryKey: ["handoff-events", id],
        enabled: id !== null,
        queryFn: () => fetchHandoffEvents({ id: id ?? "" }),
        retry: false,
    });
}
