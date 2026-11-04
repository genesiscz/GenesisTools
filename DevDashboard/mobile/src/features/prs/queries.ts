import {
    type DashboardClient,
    ENDPOINTS,
    type PrChecksDto,
    type PrFixInput,
    type PrFixReceiptDto,
    type PrMergeInput,
    type PrMergeReceiptDto,
    type PrTriageDto,
} from "@dd/contract";
import { queryOptions } from "@tanstack/react-query";

export const prKeys = {
    triage: (mine: boolean) => ["prs", "triage", mine] as const,
    checks: (url: string) => ["prs", "checks", url] as const,
};

/** The list asks the hosts for every project; once a minute is enough for a triage view. */
export const TRIAGE_INTERVAL_MS = 60_000;

export function triageQuery(client: DashboardClient, mine: boolean) {
    return queryOptions<PrTriageDto>({
        queryKey: prKeys.triage(mine),
        queryFn: () => client.call(ENDPOINTS.gatewayPrs, mine ? { mine: "1" } : {}),
        refetchInterval: TRIAGE_INTERVAL_MS,
    });
}

export function checksQuery(client: DashboardClient, url: string, enabled: boolean) {
    return queryOptions<PrChecksDto>({
        queryKey: prKeys.checks(url),
        queryFn: () => client.call(ENDPOINTS.gatewayPrChecks, { url }),
        enabled,
    });
}

export function fixPr(client: DashboardClient, input: PrFixInput & { idempotencyKey: string }): Promise<PrFixReceiptDto> {
    const { idempotencyKey, ...body } = input;
    return client.call(ENDPOINTS.prsFix, body, { idempotencyKey });
}

export function mergePr(
    client: DashboardClient,
    input: PrMergeInput & { idempotencyKey: string }
): Promise<PrMergeReceiptDto> {
    const { idempotencyKey, ...body } = input;
    return client.call(ENDPOINTS.prsMerge, body, { idempotencyKey });
}
