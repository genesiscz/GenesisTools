import { existsSync, readFileSync } from "node:fs";
import { getAiProxyStorage } from "@app/ai-proxy/lib/storage";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

export interface ModelsCatalogFile {
    updatedAt: string;
    grokVersion?: string;
    accounts: Array<{
        accountName: string;
        provider: string;
        baseUrl: string;
        pickerModels: unknown[];
        probedModels: unknown[];
        upstreamEndpoints: unknown[];
    }>;
}

/**
 * Per-USER, never committed. This file records which ids a specific account's
 * probe reached, keyed by that account's name, so it was never shareable — yet
 * it lived in `src/ai-proxy/data/` and shipped one developer's account name to
 * everyone. For any other account name the lookup simply missed and fell back,
 * silently, which is why nobody noticed for months.
 *
 * The account-agnostic knowledge (which grok ids are worth probing, and their
 * speed/thinking hints) is `GROK_STATIC_CATALOG` in code — that is the part that
 * belongs in git, and it stays there.
 */
export function catalogFilePath(): string {
    return getAiProxyStorage().modelsCatalogPath();
}

export function loadCatalogFile(): ModelsCatalogFile | null {
    const path = catalogFilePath();

    if (!existsSync(path)) {
        return null;
    }

    try {
        const parsed: unknown = SafeJSON.parse(readFileSync(path, "utf-8"));

        // The file is user-writable, and valid JSON is not a valid catalog: `{}`
        // and `[]` both parse, then `catalog.accounts.find(...)` throws in the
        // callers instead of taking the documented fallback.
        if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as ModelsCatalogFile).accounts)) {
            logger.warn({ path }, "ai-proxy: models catalog has no accounts array — ignoring it");
            return null;
        }

        // Every ELEMENT too: readers run `accounts.find(item => item.accountName === …)`,
        // and a null or primitive element throws there rather than taking the
        // documented fallback. `{"accounts":[null]}` is valid JSON.
        const accounts = (parsed as ModelsCatalogFile).accounts;

        if (accounts.some((account) => typeof account !== "object" || account === null || Array.isArray(account))) {
            logger.warn({ path }, "ai-proxy: models catalog has a malformed account entry — ignoring it");
            return null;
        }

        return parsed as ModelsCatalogFile;
    } catch (err) {
        logger.warn({ err, path }, "ai-proxy: failed to parse models catalog");
        return null;
    }
}
