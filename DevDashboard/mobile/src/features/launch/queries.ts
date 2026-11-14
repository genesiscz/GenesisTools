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

/** An account the user tapped, for the agent it was tapped under. */
export interface AccountPick {
    agentId: string;
    name: string;
}

/**
 * The account a Start uses: the user's pick while it is for this agent and the agent still lists it, else the
 * suggestion. A refetch of the options (new headroom numbers) keeps the pick; a change of agent starts from the
 * suggestion again.
 */
export function chosenAccount(agent: LaunchAgentDto | undefined, pick: AccountPick | null): string | null {
    if (agent && pick && pick.agentId === agent.id && agent.accounts.some((account) => account.name === pick.name)) {
        return pick.name;
    }

    return suggestedAccount(agent)?.name ?? null;
}

/** A Start sent with no answer yet: its body and the key a retry of exactly that body must reuse. */
export interface PendingLaunch {
    input: AgentNewInput;
    idempotencyKey: string;
}

export function sameLaunch(a: AgentNewInput, b: AgentNewInput): boolean {
    return a.agent === b.agent && a.account === b.account && a.repo === b.repo && (a.prompt ?? "") === (b.prompt ?? "");
}

/**
 * The key for a Start: the unanswered one's key when the body is the same (a retry, which the Mac answers once), and a
 * fresh key for anything else. The Mac caches a receipt by key alone, so a changed body under an old key would get the
 * earlier launch's receipt and start nothing.
 */
export function launchKey(pending: PendingLaunch | null, input: AgentNewInput, fresh: () => string): string {
    return pending && sameLaunch(pending.input, input) ? pending.idempotencyKey : fresh();
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
