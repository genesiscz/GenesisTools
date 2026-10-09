import type { AccountUsageSnapshot } from "@genesiscz/utils/ai/providers/account-features";
import { readSnapshotsCache, type SnapshotsCache } from "@genesiscz/utils/ai/usage-poll/legacy-cache";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { formatDuration } from "@genesiscz/utils/format";
import { logger } from "@genesiscz/utils/logger";
import { formatTable } from "@genesiscz/utils/table";
import { type AccountChoice, type SessionAgentId, sessionAgent } from "./session-agents";

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

function windowLeft(percentLeft: number | null, resetsAt: string | null, now: number): string {
    if (percentLeft === null) {
        return "?";
    }

    const resetMs = resetsAt ? Date.parse(resetsAt) - now : Number.NaN;
    const reset = Number.isFinite(resetMs) && resetMs > 0 ? ` (resets in ${until(resetMs)})` : "";
    return `${percentLeft}% left${reset}`;
}

/** The error text when no --account was given: every account with its budget, then what an agent must do. */
export function accountChoiceMessage(input: {
    agent: SessionAgentId;
    budgets: readonly AccountBudget[];
    retry: string;
    now?: number;
}): string {
    const now = input.now ?? Date.now();
    const table = formatTable(
        input.budgets.map((budget) => [
            budget.name,
            windowLeft(budget.fiveHourLeft, budget.fiveHourResetsAt, now),
            windowLeft(budget.weeklyLeft, budget.weeklyResetsAt, now),
            budget.note ?? "",
        ]),
        ["Account", "5h", "Weekly", "Note"],
        // A stale reading's note carries a timestamp and a reason; the shared default of 50 would cut it.
        { maxColWidth: 120 }
    );
    const rows = input.budgets.length > 0 ? table.split("\n").map((line) => `  ${line.trimEnd()}`) : [];

    return [
        `--account is required: ${toolCommand("cmux agents new")} never picks a ${input.agent} account by itself.`,
        input.budgets.length > 0 ? `${input.agent} accounts:` : `no enabled ${input.agent} account.`,
        ...rows,
        "",
        "AGENT INSTRUCTION: do not choose silently. Either ask the user which account to use, or pick the",
        "account with the most headroom AND tell the user in your reply which one you picked and why.",
        `Then run: ${input.retry}`,
    ].join("\n");
}

/** A cached reading older than this gets an age note: the poller daemon may not be running. */
const CACHE_AGE_NOTE_MS = 10 * 60_000;

/**
 * Budgets from the poller's snapshot cache, without polling. A reading older than ten minutes carries its age
 * in the note, unless the snapshot already explains why it is old or failed.
 */
export function budgetsFromCache(input: {
    provider: string;
    accounts: readonly AccountChoice[];
    cache: SnapshotsCache | null;
    now: number;
}): AccountBudget[] {
    const snapshots = (input.cache?.providers[input.provider]?.accounts ?? []).map((snapshot) => {
        const age = input.now - Date.parse(snapshot.fetchedAt);

        if (snapshot.error || snapshot.stale || !(age > CACHE_AGE_NOTE_MS)) {
            return snapshot;
        }

        return {
            ...snapshot,
            stale: {
                lastSuccessAt: snapshot.fetchedAt,
                reason: `cached ${until(age)} ago; ${toolCommand("ai usage")} refreshes it`,
            },
        };
    });

    return budgetsFromSnapshots(input.accounts, snapshots);
}

/**
 * Latest usage for the agent's accounts, read from the poller's snapshot cache only. It polls nothing, so it
 * writes no cache, loads no AI config (a load may migrate it) and never reaches a refresh token.
 */
export async function liveAccountBudgets(
    agent: SessionAgentId,
    accounts: readonly AccountChoice[]
): Promise<AccountBudget[]> {
    const provider = sessionAgent(agent).provider;

    try {
        const cache = await readSnapshotsCache();
        log.debug({ agent, provider, fetchedAt: cache?.fetchedAt ?? null }, "account budgets from the usage cache");
        return budgetsFromCache({ provider, accounts, cache, now: Date.now() });
    } catch (error) {
        log.warn({ error, agent }, "usage cache unreadable; listing accounts without budgets");
        return budgetsFromSnapshots(accounts, []);
    }
}
