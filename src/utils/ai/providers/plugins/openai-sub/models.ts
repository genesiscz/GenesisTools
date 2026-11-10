import { byProvider, openAiSubCatalogEntry } from "../../../catalog/static";
import type { CatalogEntry } from "../../../catalog/types";
import type { AccountEntry } from "../../../config/schema";
import { CodexAccountBinding } from "../../../openai/account-binding";
import { tryFetchWhamModels, type WhamModelRecord } from "../../../openai/sub-models";

/** How long a live WHAM list stays good for one account. */
export const OPENAI_SUB_MODEL_LIST_TTL_MS = 10 * 60_000;

const liveLists = new Map<string, { fetchedAt: number; entries: CatalogEntry[] }>();

export interface OpenAiSubModelListDeps {
    /** The live WHAM `/models` records of the account, or null when they cannot be read. */
    fetchRecords?: (account: AccountEntry) => Promise<WhamModelRecord[] | null>;
    now?: () => number;
}

/**
 * The account's live WHAM list, read with the stored tokens and never with a refresh: a
 * model list is not worth a single-use refresh token. An expired or unreadable credential
 * answers null, and the caller falls back to the static catalog.
 */
async function liveRecords(account: AccountEntry): Promise<WhamModelRecord[] | null> {
    try {
        const binding = await CodexAccountBinding.create(account.id, { allowRefresh: false });
        const tokens = await binding.tokens();
        return await tryFetchWhamModels(tokens.accessToken, tokens.chatgptAccountId);
    } catch {
        return null;
    }
}

/**
 * The models a Codex account can call, for the model picker. This is the only place the
 * openai-sub plugin asks WHAM `/models`; `bind` does not. A live list is kept in memory per
 * account id for ten minutes. A failed fetch is not kept, so the next picker asks again, and
 * it answers with the static catalog meanwhile.
 */
export async function listOpenAiSubModels(
    account: AccountEntry,
    deps: OpenAiSubModelListDeps = {}
): Promise<CatalogEntry[]> {
    const now = (deps.now ?? Date.now)();
    const kept = liveLists.get(account.id);

    if (kept && now - kept.fetchedAt < OPENAI_SUB_MODEL_LIST_TTL_MS) {
        return kept.entries;
    }

    const records = await (deps.fetchRecords ?? liveRecords)(account);
    const listed = (records ?? []).filter((record) => record.visibility === "list");

    if (listed.length === 0) {
        return byProvider("openai-sub");
    }

    const entries = listed.map((record) => openAiSubCatalogEntry(record, "live"));
    liveLists.set(account.id, { fetchedAt: now, entries });
    return entries;
}

/** Test seam: forget every kept list. */
export function resetOpenAiSubModelLists(): void {
    liveLists.clear();
}
