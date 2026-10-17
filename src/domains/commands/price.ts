import { checkDomains } from "@app/domains/lib/check";
import { money, statusCell } from "@app/domains/lib/display";
import { tldOf } from "@app/domains/lib/domain";
import { gatherNames, reportInvalid } from "@app/domains/lib/input";
import { holdingCost, listPrice } from "@app/domains/lib/pricing";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable } from "@genesiscz/utils/table";
import { Command } from "commander";
import pc from "picocolors";

export function createPriceCommand(): Command {
    return new Command("price")
        .description("Quote names: registrar price vs. TLD list price, and the cost of holding them for years")
        .argument("[domains...]", "domain names (also --file or stdin)")
        .option("--file <path>", "read names from a file")
        .option("-y, --years <n>", "holding period for the total", "5")
        .option("--json", "print JSON to stdout")
        .action(async (domains: string[], opts) => {
            const names = await gatherNames({ args: domains, file: opts.file });
            const years = Number.parseInt(opts.years, 10) || 5;
            const { results, invalid } = await checkDomains(names);
            const rows = await Promise.all(
                results.map(async (result) => {
                    const list = await listPrice(tldOf(result.domain));
                    const quote = result.price ?? list ?? undefined;
                    return {
                        result,
                        list,
                        total: quote && result.status !== "taken" ? holdingCost(quote, years) : undefined,
                    };
                })
            );

            if (opts.json) {
                out.result({ years, rows, invalid });
                return;
            }

            reportInvalid(invalid);
            const table = createBoxTable(["DOMAIN", "STATUS", "QUOTE 1Y", "RENEW", "TLD LIST", `${years} YEARS`]);
            for (const row of rows) {
                const quote = row.result.price;
                table.push([
                    pc.white(row.result.domain),
                    statusCell(row.result.status),
                    quote ? money(quote.registration) : pc.dim("—"),
                    quote?.renewal !== undefined ? money(quote.renewal) : pc.dim("—"),
                    row.list ? pc.dim(`${money(row.list.registration)} / ${money(row.list.renewal)}`) : pc.dim("—"),
                    row.total !== undefined ? money(row.total) : pc.dim("—"),
                ]);
            }

            out.println(table.toString());
            out.println(pc.dim("QUOTE = a per-name price (catches premiums); TLD LIST = Porkbun base price."));
        });
}
