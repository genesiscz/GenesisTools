import { money } from "@app/domains/lib/display";
import { parseMoney } from "@app/domains/lib/input";
import { type TldPrice, tldPriceTable } from "@app/domains/lib/pricing";
import { tldTier } from "@app/domains/lib/tlds";
import { isInteractive, suggestEnumFlag } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import { createBoxTable } from "@genesiscz/utils/table";
import { Command } from "commander";
import pc from "picocolors";

const SORTS = ["price", "renewal", "name", "tier"] as const;
type Sort = (typeof SORTS)[number];

const SORTERS: Record<Sort, (a: TldPrice, b: TldPrice) => number> = {
    price: (a, b) => a.registration - b.registration,
    renewal: (a, b) => a.renewal - b.renewal,
    name: (a, b) => a.tld.localeCompare(b.tld),
    tier: (a, b) => tldTier(b.tld) - tldTier(a.tld) || a.renewal - b.renewal,
};

function isSort(value: unknown): value is Sort {
    return SORTS.some((sort) => sort === value);
}

export function createTldsCommand(): Command {
    return new Command("tlds")
        .description("Browse TLD list prices (Porkbun's public table, USD)")
        .argument("[filter]", "substring to match, e.g. 'ai' or 'co.'")
        .option("--max <usd>", "renewal price ceiling")
        .option("--sort [by]", `sort by ${SORTS.join(" | ")}`, "renewal")
        .option("--promo", "only TLDs with a first-year discount")
        .option("--cc", "only two-letter country TLDs (domain-hack material)")
        .option("-n, --limit <n>", "rows to show", "50")
        .option("--json", "print JSON to stdout")
        .action(async (filter: string | undefined, opts) => {
            let sort: unknown = opts.sort;
            if (sort === true) {
                if (!isInteractive()) {
                    out.println(suggestEnumFlag("tools domains", "--sort", SORTS));
                    process.exitCode = 1;
                    return;
                }

                sort = await p.select({ message: "Sort by", options: SORTS.map((value) => ({ value, label: value })) });
            }

            if (!isSort(sort)) {
                out.println(suggestEnumFlag("tools domains", "--sort", SORTS, { given: String(sort) }));
                process.exitCode = 1;
                return;
            }

            const max = parseMoney(opts.max);
            const rows = [...(await tldPriceTable()).values()]
                .filter((row) => !filter || row.tld.includes(filter.toLowerCase().replace(/^\./, "")))
                .filter((row) => max === undefined || row.renewal <= max)
                .filter((row) => !opts.promo || row.promo)
                .filter((row) => !opts.cc || /^[a-z]{2}$/.test(row.tld))
                .sort(SORTERS[sort]);
            const shown = rows.slice(0, Number.parseInt(opts.limit, 10) || 50);

            if (opts.json) {
                out.result({ total: rows.length, tlds: shown });
                return;
            }

            const table = createBoxTable(["TLD", "1ST YEAR", "RENEWAL", "TRANSFER", "5 YEARS"]);
            for (const row of shown) {
                table.push([
                    pc.white(`.${row.tld}`),
                    row.promo ? pc.green(money(row.registration)) : money(row.registration),
                    money(row.renewal),
                    pc.dim(money(row.transfer)),
                    money(row.registration + row.renewal * 4),
                ]);
            }

            out.println(table.toString());
            out.println(pc.dim(`${shown.length} of ${rows.length} TLDs. Green = first-year promo. Source: Porkbun.`));
        });
}
