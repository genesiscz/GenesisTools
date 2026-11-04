import { out } from "@genesiscz/utils/logger";
import { renderCliHeader, renderCliKeyRow } from "@genesiscz/utils/table";
import type { Command } from "commander";
import { buildGlance } from "../lib/glance/index";

/**
 * `tools hub glance`: the phone's glance (`/api/gateway/glance`), the numbers its icon badge, Lock Screen widgets and
 * fleet Live Activity show: what waits for you, the agent fleet, the newest decisions and the window closest to its cap.
 */
export function registerGlanceCommand(program: Command): void {
    program
        .command("glance")
        .description("What waits for you, the agent fleet and the closest limit, as the phone's widgets show them")
        .option("--json", "machine-readable output")
        .action(async (_opts: unknown, command: Command) => {
            const opts = command.optsWithGlobals<{ json?: boolean }>();
            const glance = await buildGlance();

            if (opts.json) {
                out.result(glance);
                return;
            }

            const { waiting, fleet, limits } = glance;
            renderCliHeader("Glance", `${waiting.total} waiting`);
            renderCliKeyRow("Waiting", `${waiting.total} (${waiting.approvals} approvals)`);
            renderCliKeyRow("Oldest", waiting.oldest ? `${waiting.oldest.title} (${waiting.oldest.at})` : "none");
            renderCliKeyRow(
                "Fleet",
                `${fleet.working} working, ${fleet.waiting} waiting, ${fleet.stalled} stalled, ${fleet.idle} idle`
            );
            renderCliKeyRow(
                "Closest limit",
                limits
                    ? `${limits.provider} ${limits.account} ${limits.window} ${Math.round(limits.utilization)}%${limits.exhaustAt ? `, runs out ${limits.exhaustAt}` : ""}`
                    : "none"
            );
        });
}
