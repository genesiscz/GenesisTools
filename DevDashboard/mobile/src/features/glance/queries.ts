import { type DashboardClient, ENDPOINTS, type GlanceDto } from "@dd/contract";
import { queryOptions } from "@tanstack/react-query";

export const glanceKeys = { glance: ["glance"] as const };

/** The badge follows the Mac while the app runs; a closed app keeps the last number until the next start. */
export const GLANCE_INTERVAL_MS = 30_000;

export function glanceQuery(client: DashboardClient) {
    return queryOptions<GlanceDto>({
        queryKey: glanceKeys.glance,
        queryFn: () => client.call(ENDPOINTS.gatewayGlance, {}),
        refetchInterval: GLANCE_INTERVAL_MS,
    });
}

export type IconBadgeMode = "waiting" | "off";

/** The number the icon badge shows for a glance; 0 clears it. */
export function badgeNumber(glance: GlanceDto | undefined, mode: IconBadgeMode): number {
    return mode === "off" || !glance ? 0 : glance.waiting.total;
}
