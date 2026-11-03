import { type DigestOptions, digestTitle, queryDigest, writeDigestNote } from "@app/ai/lib/usage/digest-query";
import { addReservedHarnessOption } from "@genesiscz/utils/ai/usage/contract";
import { digestMarkdown } from "@genesiscz/utils/ai/usage/rollup/digest";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { guarded, printWarnings } from "./limits";

/**
 * `tools ai usage digest --day [date] | --week [date]` (design 2026-11-01, step U10, proposal 16): the day or week of
 * usage as text (markdown), `--json` (`usage.digest@1`) or `--write` (a note in the hub digest folder).
 */
export function registerAiUsageDigestCommand(usage: Command): void {
    addReservedHarnessOption(
        usage
            .command("digest")
            .description(
                "One day or week of limits, spend, workers, alerts and the outlook; --json prints usage.digest@1"
            )
            .option("--day [date]", "One local day YYYY-MM-DD (default yesterday)")
            .option("--week [date]", "The Monday-to-Sunday week holding the date (default last week)")
            .option("--tz <zone>", "IANA time zone for the days (default: the system zone)")
            .option("--json", "Print the JSON envelope")
            .option("--md", "Print the markdown note (the default text output)")
            .option("--write", "Write the note into the hub digest folder and print its path")
    ).action(async (_opts: DigestOptions, command: Command) => {
        await guarded(["digest"], async () => {
            const opts = command.optsWithGlobals<DigestOptions>();
            const envelope = await queryDigest(opts);

            if (opts.json) {
                out.result(envelope);
                await out.flush();
                return;
            }

            if (opts.write) {
                out.println(await writeDigestNote(envelope.data));
                printWarnings(envelope.warnings);
                return;
            }

            out.print(digestMarkdown(envelope.data, digestTitle(envelope.data)));
            printWarnings(envelope.warnings);
        });
    });
}
