import { renderResultTable } from "@app/domains/lib/display";
import { parseMoney } from "@app/domains/lib/input";
import { searchDomains } from "@app/domains/lib/search";
import { suggestorIds } from "@app/domains/lib/suggest";
import { DOMAIN_STATUSES, isDomainStatus } from "@app/domains/lib/types";
import { parseVariadic, suggestCommand, suggestEnumFlag } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { out } from "@genesiscz/utils/logger";
import { Command } from "commander";
import pc from "picocolors";

export function createSearchCommand(): Command {
    return new Command("search")
        .description("Generate names from a seed, check them, and rank what you can actually buy")
        .argument("<seed...>", 'what the name is about, e.g. "Genesis Tech s.r.o."')
        .option("-t, --tlds <list>", "TLDs to combine with (comma-separated)")
        .option("-s, --suggestors <ids>", `suggestors to run (${suggestorIds().join(", ")})`)
        .option("--ai", "add the LLM brainstorm suggestor (uses your default AI account)")
        .option("--about <text>", "one line about the business, for the AI suggestor")
        .option("-m, --model <ref>", "model for the AI suggestor (default: the `domains` app default)")
        .option("--rounds <n>", "AI rounds; each later round learns from what was taken (needs --ai)", "1")
        .option("--offline", "skip suggestors that need the network")
        .option("--max-price <usd>", "hide names whose first year costs more, or whose price is unknown")
        .option("--status <list>", `statuses to show (${DOMAIN_STATUSES.join(", ")})`, "available,premium")
        .option("--all", "show every status, taken names included")
        .option("-n, --limit <n>", "rows to show", "30")
        .option("--check-limit <n>", "how many top candidates to check", "150")
        .option("--vibe-lang <list>", "languages for the rude-meaning check; 'none' turns it off")
        .option("--fresh", "ignore cached check results")
        .option("--json", "print JSON to stdout")
        .action(async (seedParts: string[], opts) => {
            const requested: string[] = opts.all ? [...DOMAIN_STATUSES] : parseVariadic(opts.status);
            const badStatus = requested.find((status) => !isDomainStatus(status));
            if (badStatus !== undefined) {
                out.println(suggestEnumFlag("tools domains", "--status", DOMAIN_STATUSES, { given: badStatus }));
                process.exitCode = 1;
                return;
            }

            const vibeLang = opts.vibeLang ? parseVariadic(opts.vibeLang) : undefined;
            const spinner = opts.json ? null : out.spinner();
            spinner?.start("Generating candidates");

            const outcome = await searchDomains({
                seed: seedParts.join(" "),
                tlds: opts.tlds ? parseVariadic(opts.tlds) : undefined,
                suggestors: opts.suggestors ? parseVariadic(opts.suggestors) : undefined,
                extraSuggestors: opts.ai ? ["ai"] : undefined,
                offline: opts.offline,
                description: opts.about,
                model: opts.model,
                checkLimit: Number.parseInt(opts.checkLimit, 10) || 150,
                rounds: Number.parseInt(opts.rounds, 10) || 1,
                maxPrice: parseMoney(opts.maxPrice),
                statuses: requested.filter(isDomainStatus),
                vibeLanguages: vibeLang?.includes("none") ? [] : vibeLang,
                check: { fresh: opts.fresh },
                onProgress: (done, total, round) =>
                    spinner?.message(`${round > 1 ? `Round ${round}: checking` : "Checking"} ${done}/${total}`),
            });
            spinner?.stop(`Generated ${outcome.generated}, checked ${outcome.checked}, kept ${outcome.hits.length}`);

            const limit = Number.parseInt(opts.limit, 10) || 30;
            if (opts.json) {
                out.result({ ...outcome, hits: outcome.hits.slice(0, limit) });
                return;
            }

            if (outcome.hits.length === 0) {
                out.log.warn("Nothing matched. Try more TLDs, --ai, or a higher --max-price.");
                out.log.info(suggestCommand("tools domains", { add: ["--ai", "--tlds", "com,io,dev,ch,sh,so,gg"] }));
                return;
            }

            out.println(
                renderResultTable(
                    outcome.hits.slice(0, limit).map((hit) => ({ ...hit, result: hit.result })),
                    { showScore: true }
                )
            );
            const flagged = outcome.hits.slice(0, limit).filter((hit) => hit.vibe.length);
            if (flagged.length) {
                out.println(pc.dim(`⚠ ${flagged.length} name(s) contain a rude word in some language; see VIBE.`));
            }

            out.println(
                pc.dim(
                    `Prices are registrar quotes; confirm at checkout. Next: ${toolCommand("domains info", "<name>")}`
                )
            );
        });
}
