import { readInboxKinds, setInboxKind } from "@app/question/lib/inbox/kinds";
import {
    DEFAULT_PR_LOOKUP_CACHE_SECONDS,
    parsePrLookupCacheSeconds,
    readPrLookupCacheSeconds,
    writePrLookupCacheSeconds,
} from "@genesiscz/utils/git/origins/lookup-cache";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

export function registerConfigCommands(program: Command): void {
    const config = program
        .command("config")
        .description("Hub-wide settings, stored in ~/.genesis-tools/hub/config.json");

    config
        .command("inbox [kind] [field] [value]")
        .description(
            "Get inbox kinds or set KIND show|countInBadge on|off. Task kinds are todo.forHuman and todo.forAgent."
        )
        .option("--json", "Machine-readable settings")
        .action(
            async (
                kind: string | undefined,
                field: string | undefined,
                value: string | undefined,
                options: { json?: boolean }
            ) => {
                if (kind !== undefined && (!field || (value !== "on" && value !== "off"))) {
                    throw new Error("Choose a kind, show or countInBadge, and on or off.");
                }
                const kinds =
                    kind !== undefined && field
                        ? await setInboxKind(kind, field, value === "on")
                        : await readInboxKinds();
                if (options.json) {
                    out.result(kinds);
                    return;
                }
                const { todo, ...other } = kinds;
                for (const [name, policy] of Object.entries({
                    ...other,
                    "todo.forHuman": todo.forHuman,
                    "todo.forAgent": todo.forAgent,
                })) {
                    out.println(
                        `${name}: show ${policy.show ? "on" : "off"}, countInBadge ${policy.countInBadge ? "on" : "off"}`
                    );
                }
            }
        );

    config
        .command("get", { isDefault: true })
        .description("The current settings")
        .option("--json", "machine-readable output")
        .action(async (opts: { json?: boolean }) => {
            const prLookupCacheSeconds = await readPrLookupCacheSeconds();

            if (opts.json) {
                out.result({ prLookupCacheSeconds, inbox: { kinds: await readInboxKinds() } });
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
                const saved = await writePrLookupCacheSeconds(parsePrLookupCacheSeconds(opts.prLookupCacheSeconds));

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
