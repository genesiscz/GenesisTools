import { catalogFilePath, loadCatalogFile, type ModelsCatalogFile } from "@app/ai-proxy/lib/catalog-file";
import { loadConfig } from "@app/ai-proxy/lib/config";
import { providerDefinition } from "@app/ai-proxy/lib/providers/registry";
import { readGrokClientVersion } from "@genesiscz/utils/ai/grok";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";

type CatalogAccountEntry = ModelsCatalogFile["accounts"][number];

export async function runUpdateModelsCommand(options: {
    account?: string;
    provider?: string;
    dryRun?: boolean;
    noProbe?: boolean;
}): Promise<void> {
    const config = await loadConfig();
    const providerFilter = options.provider?.toLowerCase();

    const accounts = config.accounts.filter((account) => {
        if (options.account && account.name !== options.account) {
            return false;
        }

        if (providerFilter && account.providerSlug !== providerFilter) {
            return false;
        }

        return Boolean(providerDefinition(account.provider)?.models.catalogEntry);
    });

    if (accounts.length === 0) {
        out.log.error("No matching grok or github-copilot accounts in config");
        return;
    }

    const existing = loadCatalogFile();
    const preserved = (existing?.accounts ?? []).filter(
        (entry) =>
            !accounts.some((account) => account.name === entry.accountName && account.provider === entry.provider)
    );

    const payload = {
        updatedAt: new Date().toISOString(),
        grokVersion: readGrokClientVersion(),
        accounts: [...preserved] as CatalogAccountEntry[],
    };

    for (const account of accounts) {
        const catalogEntry = providerDefinition(account.provider)?.models.catalogEntry;

        if (!catalogEntry) {
            continue;
        }

        try {
            const result = await catalogEntry(account, { probe: !options.noProbe });

            if ("skipped" in result) {
                out.log.warn(`Skipping ${account.name}: ${result.skipped}`);
                continue;
            }

            if (result.dropped > 0) {
                out.log.info(`${account.name}: dropped ${result.dropped} probe-fail model(s) from catalog`);
            }

            payload.accounts.push(result.entry);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            out.log.warn(`Skipping ${account.name}: ${message}`);
        }
    }

    const target = catalogFilePath();

    if (options.dryRun) {
        out.log.info(`Would write ${target} (${payload.accounts.length} account(s))`);
        out.result(payload);
        return;
    }

    await Bun.write(target, `${SafeJSON.stringify(payload, null, 2)}\n`);
    out.log.success(`Wrote ${target}`);
}
