import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import {
    DEFAULT_PR_LOOKUP_CACHE_SECONDS,
    readPrLookupCacheSeconds,
    writePrLookupCacheSeconds,
} from "../lib/pr-lookup-cache";

export function registerConfigCommands(program: Command): void {
    const config = program
        .command("config")
        .description("Hub-wide settings, stored in ~/.genesis-tools/hub/config.json");

    config
        .command("get", { isDefault: true })
        .description("The current settings")
        .option("--json", "machine-readable output")
        .action(async (opts: { json?: boolean }) => {
            const prLookupCacheSeconds = await readPrLookupCacheSeconds();

            if (opts.json) {
                out.result({ prLookupCacheSeconds });
                return;
            }

            out.println(
                `prLookupCacheSeconds: ${prLookupCacheSeconds}${
                    prLookupCacheSeconds === DEFAULT_PR_LOOKUP_CACHE_SECONDS ? " (default)" : ""
                }`
            );
        });

    config
        .command("set")
        .description("Change a setting")
        .option(
            "--pr-lookup-cache-seconds <seconds>",
            "how long `repo --pr`'s PR/MR lookup is cached, keyed by branch and head commit; 0 turns it off"
        )
        .option("--json", "print the new settings as JSON")
        .action(async (opts: { prLookupCacheSeconds?: string; json?: boolean }) => {
            if (opts.prLookupCacheSeconds === undefined) {
                out.log.error("nothing to set: pass --pr-lookup-cache-seconds <seconds>");
                process.exitCode = 1;
                return;
            }

            try {
                const saved = await writePrLookupCacheSeconds(Number(opts.prLookupCacheSeconds));

                if (opts.json) {
                    out.result({ prLookupCacheSeconds: saved });
                    return;
                }

                out.log.success(`prLookupCacheSeconds: ${saved}`);
            } catch (err) {
                out.log.error(err instanceof Error ? err.message : String(err));
                process.exitCode = 1;
            }
        });
}
