import { out } from "@app/logger";
import type { Command } from "commander";
import { renderStatusTable, toJsonSnapshot } from "../render";
import { collectSnapshots } from "../sources/index";
import { parseSharedOptions } from "./shared";

export function registerStatusCommand(program: Command): void {
    program
        .command("status")
        .description("One-shot snapshot table of every tracked agent and its state")
        .option("--stall-timeout <seconds>", "Seconds without output before STALLED", "120")
        .option("--sources <names>", "Comma list: task,claude,workflows", "task,claude,workflows")
        .option("--json", "Emit a JSON snapshot to stdout", false)
        .action(async (opts: { stallTimeout: string; sources: string; json: boolean }) => {
            const { stallTimeoutMs, sources } = parseSharedOptions(opts);
            const now = Date.now();
            const snapshots = await collectSnapshots({ sources, now, stallTimeoutMs });

            if (opts.json) {
                out.result(toJsonSnapshot(snapshots, now));
                return;
            }

            out.printlnErr(`${snapshots.length} agent(s) tracked`);
            out.printlnErr(renderStatusTable(snapshots));
            await out.flush();
        });
}
