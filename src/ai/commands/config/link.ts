import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import { allReferrers } from "@genesiscz/utils/ai/config/refs";
import { out } from "@genesiscz/utils/logger";
import { renderCliHeader, renderCliSection } from "@genesiscz/utils/table";
import type { Command } from "commander";
import { printReferrerTable } from "./display";

/**
 * `tools ai config link ls` — what points at an account, so "what breaks if I
 * delete this" has an answer before the delete rather than after.
 *
 * Coverage is the config itself plus every scanner registered through
 * `registerExternalRefScanner`; the footer says so, because a link list that
 * quietly omits another tool's config is worse than no list.
 */
export async function cmdLinkLs(idOrName: string | undefined, flags: { json?: boolean }): Promise<void> {
    const store = await AiConfigStore.load();
    const config = store.data();
    const knownIds = new Set(config.accounts.map((account) => account.id));

    let account: string | undefined;
    let referrers = await allReferrers(config);

    if (idOrName) {
        const target = store.account(idOrName);
        if (!target) {
            out.log.error(`No AI account matches "${idOrName}".`);
            process.exitCode = 1;
            return;
        }

        account = target.name;
        referrers = await store.referrers(target.id);
    }

    if (flags.json) {
        out.result({ account, referrers });
        return;
    }

    if (referrers.length === 0) {
        out.log.info(account ? `Nothing references "${account}".` : "No account references anywhere in the config.");
        return;
    }

    renderCliHeader("Account links", account ? `referencing ${account}` : `${referrers.length} references`);
    printReferrerTable(referrers, knownIds);
    renderCliSection("Scope");
    out.log.info("Covers this config plus every registered external scanner (ai-proxy and friends).");
}

export function registerLinkCommands(config: Command): void {
    const link = config.command("link").description("Inspect what references an account");

    link.command("ls")
        .description("List references, config-wide or for one account")
        .argument("[idOrName]", "Limit to one account")
        .option("--json", "Emit JSON")
        .action(async (idOrName: string | undefined, flags: { json?: boolean }) => {
            await cmdLinkLs(idOrName, flags);
        });
}
