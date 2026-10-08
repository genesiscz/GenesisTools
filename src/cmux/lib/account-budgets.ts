import type { AccountUsageSnapshot } from "@genesiscz/utils/ai/providers/account-features";
import { formatDuration } from "@genesiscz/utils/format";
import { logger } from "@genesiscz/utils/logger";
import type { AccountChoice, SessionAgentId } from "./session-agents";

const { log } = logger.scoped("cmux-session");

/** What is left of one account's 5-hour and weekly windows, in percent. */
export interface AccountBudget {
    name: string;
    fiveHourLeft: number | null;
    fiveHourResetsAt: string | null;
    weeklyLeft: number | null;
    weeklyResetsAt: string | null;
    /** Why the numbers are missing or old. */
    note: string | null;
}

/** One line per account: a provider's raw error body (a JSON blob) would bury the list. */
function clip(text: string): string {
    const line = text.split("\n")[0].trim();
    return line.length > 70 ? `${line.slice(0, 69)}…` : line;
}

/** "2h 12m" under two days, "5.8d" beyond: a weekly reset reads better in days. */
function until(ms: number): string {
    return ms >= 48 * 3_600_000 ? `${(ms / 86_400_000).toFixed(1)}d` : formatDuration(ms);
}

function left(percentUsed: number): number {
    return Math.max(0, Math.round(100 - percentUsed));
}

/** One budget per enabled account of the agent's provider, from the latest usage snapshots. */
export function budgetsFromSnapshots(
    accounts: readonly AccountChoice[],
    snapshots: readonly AccountUsageSnapshot[]
): AccountBudget[] {
    return accounts.map((account) => {
        const snapshot = snapshots.find(
            (entry) => entry.accountId === account.id || entry.accountName === account.name
        );
        const session = snapshot?.limits.find((window) => window.kind === "session");
        const weekly = snapshot?.limits.find((window) => window.kind === "weekly" && !window.scopeModel);

        return {
            name: account.name,
            fiveHourLeft: session ? left(session.percentUsed) : null,
            fiveHourResetsAt: session?.resetsAt ?? null,
            weeklyLeft: weekly ? left(weekly.percentUsed) : null,
            weeklyResetsAt: weekly?.resetsAt ?? null,
            note: !snapshot
                ? "no usage reading"
                : snapshot.error
                  ? `usage read failed: ${clip(snapshot.error)}`
                  : snapshot.stale
                    ? `usage from ${snapshot.stale.lastSuccessAt} (${snapshot.stale.reason})`
                    : null,
        };
    });
}

function window(label: string, percentLeft: number | null, resetsAt: string | null, now: number): string {
    if (percentLeft === null) {
        return `${label} ?`;
    }

    const resetMs = resetsAt ? Date.parse(resetsAt) - now : Number.NaN;
    const reset = Number.isFinite(resetMs) && resetMs > 0 ? ` (resets in ${until(resetMs)})` : "";
    return `${label} ${percentLeft}% left${reset}`;
}

/** The error text when no --account was given: every account with its budget, then what an agent must do. */
export function accountChoiceMessage(input: {
    agent: SessionAgentId;
    budgets: readonly AccountBudget[];
    retry: string;
    now?: number;
}): string {
    const now = input.now ?? Date.now();
    const width = Math.max(4, ...input.budgets.map((budget) => budget.name.length));
    const rows = input.budgets.map((budget) => {
        const usage = `${window("5h", budget.fiveHourLeft, budget.fiveHourResetsAt, now)}   ${window("weekly", budget.weeklyLeft, budget.weeklyResetsAt, now)}`;
        return `  ${budget.name.padEnd(width)}  ${usage}${budget.note ? `   [${budget.note}]` : ""}`;
    });

    return [
        `--account is required: tools cmux agents new never picks a ${input.agent} account by itself.`,
        input.budgets.length > 0 ? `${input.agent} accounts:` : `no enabled ${input.agent} account.`,
        ...rows,
        "",
        "AGENT INSTRUCTION: do not choose silently. Either ask the user which account to use, or pick the",
        "account with the most headroom AND tell the user in your reply which one you picked and why.",
        `Then run: ${input.retry}`,
    ].join("\n");
}

/** Latest usage for the agent's accounts. Probe mode: it never spends a single-use refresh token. */
export async function liveAccountBudgets(
    agent: SessionAgentId,
    accounts: readonly AccountChoice[]
): Promise<AccountBudget[]> {
    try {
        const { pollAccounts } = await import("@genesiscz/utils/ai/usage-poll/poll");
        const snapshots = await pollAccounts({ providers: [agent], probe: true, maxStaleMs: 10 * 60_000 });
        return budgetsFromSnapshots(accounts, snapshots);
    } catch (error) {
        log.warn({ error, agent }, "usage poll failed; listing accounts without budgets");
        return budgetsFromSnapshots(accounts, []);
    }
}
