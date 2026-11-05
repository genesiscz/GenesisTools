import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader } from "@genesiscz/utils/table";
import type { Command } from "commander";
import { addPing, checkPings, listPings, removePing } from "../lib/ping/index";

/**
 * `tools hub ping`: "ping me when done" watches on live agent sessions (F15). `add` sets one (and registers the minute
 * daemon task), `check` is what that task runs: one push to the phone per turn that ended.
 */
export function registerPingCommand(program: Command): void {
    const ping = program
        .command("ping")
        .description("Push to the phone when a watched agent turn ends")
        .option("--json", "machine-readable output")
        .action((_opts: unknown, command: Command) => {
            const opts = command.optsWithGlobals<{ json?: boolean }>();
            const { watches } = listPings();

            if (opts.json) {
                out.result({ watches });
                return;
            }

            renderCliHeader("Ping me when done", `${watches.length} watched`);
            const table = createBoxTable(["KEY", "LABEL", "SINCE"]);

            for (const watch of watches) {
                table.push([watch.key, watch.label ?? "", watch.since]);
            }

            out.println(table.toString());
        });

    ping.command("add <key>")
        .description(`Watch a session by its agents board key (${toolCommand("hub board")})`)
        .option("--label <text>", "what the push names")
        .action(async (key: string, _opts: unknown, command: Command) => {
            const opts = command.optsWithGlobals<{ label?: string; json?: boolean }>();
            const watches = await addPing({ key, label: opts.label ?? null });
            out.log.success(`watching ${key} (${watches.watches.length} watched)`);
        });

    ping.command("rm <key>")
        .description("Stop watching a session")
        .action(async (key: string) => {
            const watches = await removePing(key);
            out.log.info(`${watches.watches.length} watched`);
        });

    ping.command("check")
        .description("Push for every watched turn that ended (the minute daemon task runs this)")
        .option("--json", "machine-readable output")
        .action(async (_opts: unknown, command: Command) => {
            const opts = command.optsWithGlobals<{ json?: boolean }>();
            const outcomes = await checkPings();

            if (opts.json) {
                out.result({ outcomes });
                return;
            }

            for (const outcome of outcomes) {
                out.log.info(`${outcome.key}: ${outcome.state}${outcome.pushed ? ", pushed" : ""}`);
            }
        });
}
