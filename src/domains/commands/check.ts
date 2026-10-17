import { checkDomains } from "@app/domains/lib/check";
import { renderResultTable } from "@app/domains/lib/display";
import { gatherNames, reportInvalid } from "@app/domains/lib/input";
import { providerIds } from "@app/domains/lib/providers/registry";
import { parseVariadic, suggestCommand } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import { Command } from "commander";

export function createCheckCommand(): Command {
    return new Command("check")
        .description("Check whether names are free, premium, taken or parked for sale")
        .argument("[domains...]", "domain names (also read from --file or piped stdin)")
        .option("--file <path>", "read names from a file, one per line")
        .option("-p, --provider <ids>", `ask exactly these providers (${providerIds().join(", ")})`)
        .option("--details", "also fetch registrar and expiry for taken names (RDAP)")
        .option("--fresh", "ignore cached results")
        .option("-c, --concurrency <n>", "parallel checks", "12")
        .option("--json", "print JSON to stdout")
        .action(async (domains: string[], opts) => {
            const names = await gatherNames({ args: domains, file: opts.file });
            if (names.length === 0) {
                out.log.error("No names given.");
                out.log.info(
                    suggestCommand("tools domains", { replaceCommand: ["check", "genesiste.ch", "genesistech.cz"] })
                );
                process.exitCode = 1;
                return;
            }

            const spinner = opts.json ? null : out.spinner();
            spinner?.start(`Checking ${names.length} name(s)`);
            let done = 0;
            const { results, invalid } = await checkDomains(names, {
                providers: opts.provider ? parseVariadic(opts.provider) : undefined,
                details: opts.details,
                fresh: opts.fresh,
                concurrency: Number.parseInt(opts.concurrency, 10) || 12,
                onResult: () => spinner?.message(`Checked ${++done}/${names.length}`),
            });
            spinner?.stop(`Checked ${results.length} name(s)`);

            if (opts.json) {
                out.result({ results, invalid });
                return;
            }

            reportInvalid(invalid);
            out.println(renderResultTable(results.map((result) => ({ result }))));
        });
}
