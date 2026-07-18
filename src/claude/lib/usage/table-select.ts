import type { AIAccountEntry } from "@genesiscz/utils/config/ai.types";
import { type TableSelectOptions, tableSelect } from "@genesiscz/utils/prompts/p";
import type { ScoredAccount } from "./account-picker";
import { accountCells, detailBlock, TIER_BADGE } from "./usage-table";

interface AccountTableOptions {
    message: string;
    scored: ScoredAccount[];
    accountsByName: Map<string, AIAccountEntry>;
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
            detail: detailBlock(acc, opts.accountsByName.get(acc.accountName), now),
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
