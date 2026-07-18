import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { createNotifier, parseChannels } from "../notify";
import { runWatch } from "../watcher";
import { parseNonNegativeInt, parseSharedOptions } from "./shared";

interface WatchOpts {
    stallTimeout: string;
    sources: string;
    notify: string;
    json: boolean;
    once: boolean;
    poll: string;
    active: string;
}

export function registerWatchCommand(program: Command): Command {
    return program
        .command("watch", { isDefault: true })
        .description("Live-watch agents and notify on finish/stall/awaiting-input transitions")
        .option("--stall-timeout <seconds>", "Seconds without output before STALLED", "120")
        .option("--sources <names>", "Comma list: task,claude,workflows", "task,claude,workflows")
        .option("--notify <channels>", "Comma list: terminal,say,telegram | none", "terminal")
        .option("--poll <seconds>", "Re-sweep cadence (catches stalls)", "5")
        .option("--active <minutes>", "Only consider agents active within this window (0 = all)", "60")
        .option("--json", "Emit a JSON event per notification to stdout", false)
        .option("--once", "Single pass then exit (cron-friendly)", false)
        .action(async (opts: WatchOpts) => {
            const { stallTimeoutMs, sources, activeWindowMs } = parseSharedOptions(opts);
            const channels = parseChannels(opts.notify);
            const pollSeconds = parseNonNegativeInt(opts.poll, "--poll");
            const pollMs = Math.max(1, pollSeconds > 0 ? pollSeconds : 5) * 1000;
            const notifier = createNotifier(channels);

            out.log.info(
                `agent-watch · sources: ${sources.join(",")} · notify: ${channels.join(",") || "none"} · stall ${stallTimeoutMs / 1000}s · active ${activeWindowMs ? `${activeWindowMs / 60_000}m` : "all"}`
            );

            await runWatch({
                sources,
                stallTimeoutMs,
                pollMs,
                notifier,
                json: opts.json,
                once: opts.once,
                activeWindowMs,
            });
        });
}
