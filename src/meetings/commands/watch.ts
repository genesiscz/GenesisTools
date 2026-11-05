import { join } from "node:path";
import { spawnToolDetached } from "@genesiscz/utils/cli";
import { ui } from "@genesiscz/utils/cli/ui";
import { logger } from "@genesiscz/utils/logger";
import { MeetingsConfigStore } from "@genesiscz/utils/meetings/config";
import { MeetingStore } from "@genesiscz/utils/meetings/record";
import { claimPidFile, clearPidFile, inspectPidFile } from "@genesiscz/utils/process/pidfile";
import type { Command } from "commander";
import { askAtMeetingEnd, hasOpenAssignSteps } from "../lib/assign";
import { errorText, fail, resolveEnum } from "../lib/shared";
import { watchLoop, watchOnce } from "../lib/watch";

const { log } = logger.scoped("meetings-watch-cmd");
/** How long `ensureWatcher` waits for the spawned watcher to own its pidfile. */
const WATCHER_CLAIM_MS = 15_000;

export function watcherPidPath(store: MeetingStore): string {
    return join(store.root, "watch.pid");
}

/**
 * Starts the watcher in the background unless it runs already, or autoRecord is off and no project question or
 * folder step waits (the watcher's sweep is what reads those back). The daemon calls it at login.
 */
export async function ensureWatcher(): Promise<"started" | "running" | "disabled"> {
    const config = await new MeetingsConfigStore().read();

    if (!config.sources.wisprflow.autoRecord.enabled && !hasOpenAssignSteps(new MeetingStore())) {
        return "disabled";
    }

    if (inspectPidFile(watcherPidPath(new MeetingStore())).status === "live") {
        return "running";
    }

    const pid = spawnToolDetached(["meetings", "watch"]);
    // "started" means the child owns the pidfile, so a second ensureWatcher in this window does not spawn another.
    const deadline = Date.now() + WATCHER_CLAIM_MS;

    while (inspectPidFile(watcherPidPath(new MeetingStore())).status !== "live") {
        if (Date.now() >= deadline) {
            throw new Error(
                `The meetings watcher did not claim its pidfile within ${WATCHER_CLAIM_MS / 1000} seconds.`
            );
        }

        await Bun.sleep(Math.min(500, deadline - Date.now()));
    }

    log.info({ pid }, "meetings watcher started in the background");
    return "started";
}

/**
 * "Ask each time" at the end of a meeting (the recorder's stop, a source link that ends it), then the watcher, so the
 * answer is read back even while autoRecord is off. Never throws; every failure is a warning naming the meeting.
 */
export async function askProjectAtEnd(store: MeetingStore, meetingId: string): Promise<void> {
    const asked = await askAtMeetingEnd(store, meetingId);

    if (!asked.formId && !hasOpenAssignSteps(store)) {
        return;
    }

    await ensureWatcher().catch((err: unknown) =>
        log.warn({ err, meeting: meetingId }, "the watcher that reads the project answer back did not start")
    );
}

/** Claims the watcher's pidfile: a dead or foreign owner is taken over, a live one is refused. */
export async function claimWatcher(store: MeetingStore): Promise<void> {
    const file = watcherPidPath(store);
    const claim = await claimPidFile(file, {
        reclaimable: (state) => state.status === "dead" || state.status === "foreign",
    });

    if (claim.status !== "claimed") {
        const owner = claim.status === "held" && "pid" in claim.state ? ` (pid ${claim.state.pid})` : "";
        throw new Error(`another meetings watcher holds ${file}${owner}`);
    }
}

async function watch(opts: { once?: boolean }): Promise<void> {
    const store = new MeetingStore();

    try {
        if (opts.once) {
            ui.info(await watchOnce(store));
            return;
        }

        await claimWatcher(store);

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
