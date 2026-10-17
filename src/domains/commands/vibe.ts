import { parseDomain } from "@app/domains/lib/domain";
import { VIBE_LANGUAGES, vibeCheck } from "@app/domains/lib/vibe";
import { parseVariadic } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import { Command } from "commander";
import pc from "picocolors";

export function createVibeCommand(): Command {
    return new Command("vibe")
        .description("Check whether a name contains a rude word in another language (bereshit = 'bere shit' in Czech)")
        .argument("<names...>", "labels or domains")
        .option("-l, --lang <list>", `languages (default: ${VIBE_LANGUAGES.join(",")})`)
        .option("--json", "print JSON to stdout")
        .action(async (names: string[], opts) => {
            const languages = opts.lang ? parseVariadic(opts.lang) : VIBE_LANGUAGES;
            const report = await Promise.all(
                names.map(async (name) => {
                    const label = parseDomain(name)?.label ?? name;
                    return { name, label, hits: await vibeCheck(label, languages) };
                })
            );

            if (opts.json) {
                out.result({ languages, report });
                return;
            }

            for (const entry of report) {
                if (entry.hits.length === 0) {
                    out.println(
                        `${pc.green("✓")} ${pc.white(entry.name)} ${pc.dim(`clean in ${languages.length} languages`)}`
                    );
                    continue;
                }

                const words = entry.hits
                    .map((hit) => `"${hit.word}" (${hit.languages.join(", ")}; ${hit.position})`)
                    .join(", ");
                out.println(`${pc.red("⚠")} ${pc.white(entry.name)} contains ${words}`);
            }

            if (report.some((entry) => entry.hits.length)) {
                process.exitCode = 2;
            }

            out.println(
                pc.dim("Word lists: LDNOOBW on GitHub. They catch spelling, not sound; say the name out loud too.")
            );
        });
}
