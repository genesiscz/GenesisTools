import { join } from "node:path";
import { spawnToolDetached } from "@genesiscz/utils/cli";
import { ui } from "@genesiscz/utils/cli/ui";
import { logger } from "@genesiscz/utils/logger";
import { MeetingsConfigStore } from "@genesiscz/utils/meetings/config";
import { MeetingStore } from "@genesiscz/utils/meetings/record";
import { clearPidFile, inspectPidFile, writePidFile } from "@genesiscz/utils/process/pidfile";
import type { Command } from "commander";
import { errorText, fail, resolveEnum } from "../lib/shared";
import { watchLoop, watchOnce } from "../lib/watch";

const { log } = logger.scoped("meetings-watch-cmd");

export function watcherPidPath(store: MeetingStore): string {
    return join(store.root, "watch.pid");
}

/** Starts the watcher in the background unless it runs already or autoRecord is off. The daemon calls it at login. */
export async function ensureWatcher(): Promise<"started" | "running" | "disabled"> {
    const config = await new MeetingsConfigStore().read();

    if (!config.sources.wisprflow.autoRecord.enabled) {
        return "disabled";
    }

    if (inspectPidFile(watcherPidPath(new MeetingStore())).status === "live") {
        return "running";
    }

    const pid = spawnToolDetached(["meetings", "watch"]);
    log.info({ pid }, "meetings watcher started in the background");
    return "started";
}

async function watch(opts: { once?: boolean }): Promise<void> {
    const store = new MeetingStore();

    try {
        if (opts.once) {
            ui.info(await watchOnce(store));
            return;
        }

        writePidFile(watcherPidPath(store), { exclusive: true });

        try {
            await watchLoop(store);
        } finally {
            clearPidFile(watcherPidPath(store));
        }
    } catch (err) {
        fail(errorText(err));
    }
}

const MODES = ["on", "off", "status"] as const;

async function autostart(mode: string | undefined): Promise<void> {
    const picked = await resolveEnum({
        value: mode,
        fallback: "status",
        values: MODES,
        flag: "<mode>",
        subcommand: ["autostart"],
    });
    const store = new MeetingsConfigStore();

    if (!picked) {
        return;
    }

    try {
        if (picked !== "status") {
            await store.setAutoRecord(picked === "on");
        }

        const config = await store.read();
        const running = inspectPidFile(watcherPidPath(new MeetingStore())).status === "live";
        const enabled = config.sources.wisprflow.autoRecord.enabled;

        if (enabled && !running && picked === "on") {
            await ensureWatcher();
        }

        ui.ok(
            `Recording starts with Wispr Flow: ${enabled ? "on" : "off"}. Watcher: ${enabled && (running || picked === "on") ? "running" : "not running"}.`
        );
    } catch (err) {
        fail(errorText(err));
    }
}

export function registerWatchCommands(program: Command): void {
    program
        .command("watch")
        .description(
            "Start and stop the screen recording with Wispr Flow's own (runs in the background when autostart is on)"
        )
        .option("--once", "look once and print what it did")
        .action(watch);

    program
        .command("autostart")
        .argument("[mode]", "on | off | status")
        .description("Record the screen whenever Wispr Flow records a meeting (default off)")
        .action(autostart);
}
