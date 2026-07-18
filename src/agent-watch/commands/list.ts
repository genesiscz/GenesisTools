import { logger, out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { collectSnapshots } from "../sources/index";
import { parseSharedOptions } from "./shared";

export function registerListCommand(program: Command): void {
    program
        .command("list")
        .description("List discovered agents (id + source), no state classification")
        .option("--sources <names>", "Comma list: task,claude,workflows", "task,claude,workflows")
        .option("--active <minutes>", "Only list agents active within this window (0 = all)", "0")
        .option("--json", "Emit JSON to stdout", false)
        .action(async (opts: { sources: string; active: string; json: boolean }) => {
            const { sources, activeWindowMs } = parseSharedOptions({ ...opts, stallTimeout: "120" });
            logger.debug({ sources, activeWindowMs }, "agent-watch list: collecting");
            const snapshots = await collectSnapshots({
                sources,
                now: Date.now(),
                stallTimeoutMs: 120_000,
                activeWindowMs,
            });
            const rows = snapshots.map((s) => ({ id: s.id, name: s.name, source: s.source }));
            logger.debug({ count: rows.length }, "agent-watch list: collected");

            if (opts.json) {
                out.result(rows);
                await out.flush();
                return;
            }

            for (const r of rows) {
                out.printlnErr(`${r.source.padEnd(10)} ${r.id}`);
            }

            await out.flush();
        });
}
