import { ENDPOINTS } from "@app/dev-dashboard/contract/endpoint-table";
import type { HandoffEventsResponse } from "@app/dev-dashboard/lib/handoff-types";
import { useQuery } from "@tanstack/react-query";
import { dashboard, withServerMessage } from "@/lib/dashboard-client";

export async function fetchHandoffEvents(input: {
    id: string;
    limit?: number;
    before?: string;
    beforeUid?: string;
}): Promise<HandoffEventsResponse> {
    return withServerMessage(
        dashboard.call(ENDPOINTS.handoffEvents, {
            id: input.id,
            limit: input.limit ?? 200,
            before: input.before,
            beforeUid: input.beforeUid,
        })
    );
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
