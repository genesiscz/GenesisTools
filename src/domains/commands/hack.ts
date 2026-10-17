import { checkDomains } from "@app/domains/lib/check";
import { renderResultTable } from "@app/domains/lib/display";
import { seedWords } from "@app/domains/lib/domain";
import { findHacks, hackSources } from "@app/domains/lib/suggest/hacks";
import { allTlds } from "@app/domains/lib/tlds";
import { out } from "@genesiscz/utils/logger";
import { Command } from "commander";
import pc from "picocolors";

export function createHackCommand(): Command {
    return new Command("hack")
        .description("Find domain hacks, where a real TLD finishes the word (genesiste.ch, del.icio.us)")
        .argument("<words...>", "a word or phrase")
        .option("--min-label <n>", "shortest label left of the dot", "2")
        .option("--no-check", "only list the hacks, do not check them")
        .option("--free", "show only names you can register")
        .option("--json", "print JSON to stdout")
        .action(async (words: string[], opts) => {
            const tlds = await allTlds();
            const minLabel = Number.parseInt(opts.minLabel, 10) || 2;
            const sources = hackSources(seedWords(words.join(" ")));
            const hacks = [
                ...new Map(sources.flatMap((s) => findHacks(s, tlds, minLabel)).map((h) => [h.domain, h])).values(),
            ];

            if (!opts.check) {
                if (opts.json) {
                    out.result({ hacks });
                    return;
                }

                for (const hack of hacks) {
                    out.println(`${pc.white(hack.domain.padEnd(28))} ${pc.dim(hack.reason ?? "")}`);
                }

                return;
            }

            if (hacks.length === 0) {
                out.log.warn(`No TLD ends any of: ${sources.join(", ")}`);
                return;
            }

            const spinner = opts.json ? null : out.spinner();
            spinner?.start(`Checking ${hacks.length} hack(s)`);
            const { results } = await checkDomains(hacks.map((hack) => hack.domain));
            spinner?.stop(`Checked ${results.length} hack(s)`);
            const reasons = new Map(hacks.map((hack) => [hack.domain, hack.reason]));
            const shown = opts.free
                ? results.filter((result) => result.status === "available" || result.status === "premium")
                : results;

            if (opts.json) {
                out.result({ results: shown });
                return;
            }

            out.println(renderResultTable(shown.map((result) => ({ result, reason: reasons.get(result.domain) }))));
        });
}
