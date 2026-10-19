import { scoreCandidate } from "@app/domains/lib/score";
import { SUGGESTORS, suggest, suggestorIds } from "@app/domains/lib/suggest";
import { parseVariadic } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliSection, truncateDisplay } from "@genesiscz/utils/table";
import { Command } from "commander";
import pc from "picocolors";

export function createSuggestCommand(): Command {
    return new Command("suggest")
        .description("Generate candidate names from a seed, ranked, without checking them")
        .argument("[seed...]", "what the name is about")
        .option("-t, --tlds <list>", "TLDs to combine with (comma-separated)")
        .option("-s, --suggestors <ids>", `suggestors to run (${suggestorIds().join(", ")})`)
        .option("--ai", "add the LLM brainstorm suggestor")
        .option("--about <text>", "one line about the business, for the AI suggestor")
        .option(
            "-m, --model <ref>",
            "model for the AI suggestor: a bare id (sonnet) or a full ref (@account/<id>:<model>)"
        )
        .option(
            "--account <name>",
            "AI account for the AI suggestor, or auto: the subscription account with the most room (default)"
        )
        .option("--offline", "skip suggestors that need the network")
        .option("--list", "list the suggestors and exit")
        .option("-n, --limit <n>", "rows to show", "60")
        .option("--json", "print JSON to stdout")
        .action(async (seedParts: string[], opts) => {
            if (opts.list || seedParts.length === 0) {
                if (opts.json) {
                    out.result({
                        suggestors: SUGGESTORS.map(({ id, label, online, defaultOn }) => ({
                            id,
                            label,
                            online,
                            defaultOn,
                        })),
                    });
                    return;
                }

                renderCliSection("Suggestors");
                for (const suggestor of SUGGESTORS) {
                    const flags = [suggestor.defaultOn ? "default" : "opt-in", suggestor.online ? "online" : "offline"];
                    out.println(
                        `  ${pc.cyan(suggestor.id.padEnd(9))} ${suggestor.label} ${pc.dim(`(${flags.join(", ")})`)}`
                    );
                }

                return;
            }

            const candidates = await suggest({
                seed: seedParts.join(" "),
                tlds: opts.tlds ? parseVariadic(opts.tlds) : undefined,
                suggestors: opts.suggestors ? parseVariadic(opts.suggestors) : undefined,
                extraSuggestors: opts.ai ? ["ai"] : undefined,
                offline: opts.offline,
                description: opts.about,
                model: opts.model,
                account: opts.account,
            });
            const ranked = candidates
                .map((candidate) => ({ ...candidate, score: scoreCandidate(candidate) }))
                .sort((a, b) => b.score - a.score)
                .slice(0, Number.parseInt(opts.limit, 10) || 60);

            if (opts.json) {
                out.result({ total: candidates.length, candidates: ranked });
                return;
            }

            const table = createBoxTable(["SCORE", "DOMAIN", "FROM", "WHY"]);
            for (const candidate of ranked) {
                table.push([
                    String(candidate.score),
                    pc.white(candidate.domain),
                    pc.dim(candidate.sources.join(",")),
                    pc.dim(truncateDisplay(candidate.reason ?? "", 50)),
                ]);
            }

            out.println(table.toString());
            out.println(
                pc.dim(`${candidates.length} generated. Check them: ${toolCommand("domains search", ...seedParts)}`)
            );
        });
}
