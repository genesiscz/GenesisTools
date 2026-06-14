import { out } from "@app/logger";
import type { Command } from "commander";
import { collectSnapshots } from "../sources/index";
import { parseSharedOptions } from "./shared";

export function registerListCommand(program: Command): void {
    program
        .command("list")
        .description("List discovered agents (id + source), no state classification")
        .option("--sources <names>", "Comma list: task,claude,workflows", "task,claude,workflows")
        .option("--json", "Emit JSON to stdout", false)
        .action(async (opts: { sources: string; json: boolean }) => {
            const { sources } = parseSharedOptions({ ...opts, stallTimeout: "120" });
            const snapshots = await collectSnapshots({ sources, now: Date.now(), stallTimeoutMs: 120_000 });
            const rows = snapshots.map((s) => ({ id: s.id, name: s.name, source: s.source }));

            if (opts.json) {
                out.result(rows);
                return;
            }

            for (const r of rows) {
                out.println(`${r.source.padEnd(10)} ${r.id}`);
            }

            await out.flush();
        });
}
