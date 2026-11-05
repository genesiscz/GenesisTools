import { out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import type { Command } from "commander";
import { launchOptions } from "../lib/launch/index";

/**
 * `tools hub launch`: what the phone's New agent sheet offers (`/api/gateway/launch`): every harness with its
 * accounts ranked by headroom from the usage cache, and the project folders. The start itself is
 * `tools cmux agents new` (`POST /api/agents/new`).
 */
export function registerLaunchCommand(program: Command): void {
    program
        .command("launch")
        .description("Harnesses, accounts ranked by headroom (cached readings only) and repos for starting an agent")
        .option("--json", "machine-readable output")
        .action(async (opts: { json?: boolean }) => {
            const options = await launchOptions();

            if (opts.json) {
                out.result(options);
                return;
            }

            renderCliHeader("Start an agent", `${options.repos.length} repos`);
            const table = createBoxTable(["AGENT", "ACCOUNT", "TIER", "5H LEFT", "LONG LEFT", "WHY"]);

            for (const agent of options.agents) {
                for (const account of agent.accounts) {
                    table.push([
                        agent.id,
                        account.name,
                        account.tier,
                        account.sessionLeftPct === null ? "" : `${account.sessionLeftPct}%`,
                        account.longLeftPct === null ? "" : `${account.longLeftPct}%`,
                        truncateDisplay(account.why, 40),
                    ]);
                }
            }

            out.println(table.toString());
        });
}
