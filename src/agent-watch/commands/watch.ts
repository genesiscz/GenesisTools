import { out } from "@app/logger";
import type { Command } from "commander";
import { createNotifier, parseChannels } from "../notify";
import { runWatch } from "../watcher";
import { parseSharedOptions } from "./shared";

interface WatchOpts {
    stallTimeout: string;
    sources: string;
    notify: string;
    json: boolean;
    once: boolean;
    poll: string;
}

export function registerWatchCommand(program: Command): Command {
    return program
        .command("watch", { isDefault: true })
        .description("Live-watch agents and notify on finish/stall/awaiting-input transitions")
        .option("--stall-timeout <seconds>", "Seconds without output before STALLED", "120")
        .option("--sources <names>", "Comma list: task,claude,workflows", "task,claude,workflows")
        .option("--notify <channels>", "Comma list: terminal,say,telegram | none", "terminal")
        .option("--poll <seconds>", "Re-sweep cadence (catches stalls)", "5")
        .option("--json", "Emit a JSON event per notification to stdout", false)
        .option("--once", "Single pass then exit (cron-friendly)", false)
        .action(async (opts: WatchOpts) => {
            const { stallTimeoutMs, sources } = parseSharedOptions(opts);
            const channels = parseChannels(opts.notify);
            const pollMs = Math.max(1, Number.parseInt(opts.poll, 10) || 5) * 1000;
            const notifier = createNotifier(channels);

            out.log.info(
                `agent-watch · sources: ${sources.join(",")} · notify: ${channels.join(",") || "none"} · stall ${stallTimeoutMs / 1000}s`
            );

            await runWatch({ sources, stallTimeoutMs, pollMs, notifier, json: opts.json, once: opts.once });
        });
}
