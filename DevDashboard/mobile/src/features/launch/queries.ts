import {
    type AgentNewInput,
    type AgentNewReceiptDto,
    type DashboardClient,
    ENDPOINTS,
    type LaunchAccountDto,
    type LaunchAgentDto,
    type LaunchOptionsDto,
} from "@dd/contract";
import { queryOptions } from "@tanstack/react-query";

export const launchKeys = { options: ["launch", "options"] as const };

export function launchQuery(client: DashboardClient) {
    return queryOptions<LaunchOptionsDto>({
        queryKey: launchKeys.options,
        queryFn: () => client.call(ENDPOINTS.gatewayLaunch, {}),
        staleTime: 30_000,
    });
}

export function startAgent(
    client: DashboardClient,
    input: AgentNewInput & { idempotencyKey: string }
): Promise<AgentNewReceiptDto> {
    const { idempotencyKey, ...body } = input;
    return client.call(ENDPOINTS.agentsNew, body, { idempotencyKey });
}

/** The account the sheet picks first: the best one `auto` may use (ready, then session-starved). */
export function suggestedAccount(agent: LaunchAgentDto | undefined): LaunchAccountDto | undefined {
    return agent?.accounts.find((account) => account.tier === "ready" || account.tier === "session-starved");
}

/** "5h 62% · week 40%", or why there are no numbers. */
export function headroomLine(account: LaunchAccountDto): string {
    if (account.sessionLeftPct === null && account.longLeftPct === null) {
        return account.why;
    }

    const parts = [
        account.sessionLeftPct === null ? null : `5h ${account.sessionLeftPct}%`,
        account.longLeftPct === null ? null : `long ${account.longLeftPct}%`,
        account.sessions > 0 ? `${account.sessions} running` : null,
    ];
    return parts.filter(Boolean).join(" · ");
}

export const TIER_LABELS: Readonly<Record<LaunchAccountDto["tier"], string>> = {
    ready: "Ready",
    "session-starved": "5h low",
    "weekly-blocked": "Blocked",
    "no-data": "No data",
};

/** Repos whose name contains the filter, case-insensitive; the list keeps its most-recent-first order. */
export function filterRepos(repos: readonly string[], filter: string): string[] {
    const needle = filter.trim().toLowerCase();
    return needle ? repos.filter((repo) => repo.toLowerCase().includes(needle)) : [...repos];
}
