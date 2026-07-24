import type { AIAccountEntry } from "@genesiscz/utils/config/ai.types";
import { logger } from "@genesiscz/utils/logger";
import { type TableSelectOptions, tableSelect } from "@genesiscz/utils/prompts/p";
import type { ScoredAccount } from "./account-picker";
import { atYourPace, type PaceScope } from "./burn-pace";
import { UsageHistoryDb } from "./history-db";
import { accountCells, type DetailBlockPace, detailBlock, TIER_BADGE } from "./usage-table";

interface AccountTableOptions {
    message: string;
    scored: ScoredAccount[];
    accountsByName: Map<string, AIAccountEntry>;
    /** Defaults to the dashboard config's `paceScope`; `pooled` when unset. */
    paceScope?: PaceScope;
}

/** "≈35m at pace" for each bucket, read from the SQLite poll history — best-effort, never blocks the picker. */
function pacesFor(accountName: string, acc: ScoredAccount, now: Date, scope: PaceScope | undefined): DetailBlockPace {
    try {
        // No dbPath -> resolves the process-wide ClaudeDatabase singleton; schema
        // setup is WeakSet-guarded, so this is cheap even called once per row.
        const db = new UsageHistoryDb();
        const limits = acc.limits;
        const pace = (bucket: string, leftPct: number) =>
            atYourPace(db, { accountName, bucket, utilizationPct: 100 - leftPct, scope }, now);

        return {
            session: limits?.session ? pace("five_hour", limits.session.leftPct) : undefined,
            weekly: limits?.weekly ? pace("seven_day", limits.weekly.leftPct) : undefined,
            fable: limits?.fable ? pace("seven_day_fable", limits.fable.leftPct) : undefined,
        };
    } catch (error) {
        // Pace is a nice-to-have annotation — a DB hiccup must not break the
        // picker, but it must not vanish silently either: a schema/query failure
        // would otherwise be indistinguishable from "not enough history yet".
        logger.debug({ error, accountName }, "[usage] pace lookup failed; rendering without it");
        return {};
    }
}

/** Map scored accounts onto the generic table-select prompt (exported for tests). */
export function buildAccountTableOpts(opts: AccountTableOptions, now: Date = new Date()): TableSelectOptions<string> {
    return {
        message: opts.message,
        hint: "(best first, % left)",
        columns: [
            { label: "ACCOUNT", minWidth: 7 },
            { label: "5H", align: "right", minWidth: 4 },
            { label: "WL", align: "right", minWidth: 4 },
            { label: "FB", align: "right", minWidth: 4 },
            { label: "RESETS 5H·WL", minWidth: 12 },
        ],
        rows: opts.scored.map((acc) => ({
            value: acc.accountName,
            badge: TIER_BADGE[acc.tier],
            cells: accountCells(acc, now),
            detail: detailBlock(
                acc,
                opts.accountsByName.get(acc.accountName),
                now,
                pacesFor(acc.accountName, acc, now, opts.paceScope)
            ),
        })),
    };
}

/**
 * Account picker: column table (5h / weekly / Fable headroom, coarse resets)
 * plus a fixed-height detail zone with headroom bars for the focused account.
 * Returns the picked account name, or null on cancel.
 */
export async function tableSelectAccount(opts: AccountTableOptions): Promise<string | null> {
    return tableSelect(buildAccountTableOpts(opts));
}
