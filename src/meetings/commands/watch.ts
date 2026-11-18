import { ui } from "@genesiscz/utils/cli/ui";
import { logger } from "@genesiscz/utils/logger";
import { MeetingStore } from "@genesiscz/utils/meetings/record";
import { localTime } from "@genesiscz/utils/transcribe/render";
import type { Command } from "commander";
import { askAtMeetingEnd, hasOpenAssignSteps } from "../lib/assign";
import { fail, resolveEnum } from "../lib/shared";
import { hasSourceAudioToWatch, watchOnce } from "../lib/watch";
import { ensureWatcher, recordingAutostart, runWatcher, shouldStartWatcherForRecording } from "../lib/watcher";

const { log } = logger.scoped("meetings-watch-cmd");

/**
 * "Ask each time" at the end of a meeting (the recorder's stop, a source link that ends it), then the watcher, so the
 * answer is read back even while autoRecord is off. A scratch store with autostart off gets no watcher, as at
 * `record start` (`shouldStartWatcherForRecording`). Never throws; every failure is a warning naming the meeting.
 */
export async function askProjectAtEnd(store: MeetingStore, meetingId: string): Promise<void> {
    const asked = await askAtMeetingEnd(store, meetingId);

    if (!asked.formId && !hasOpenAssignSteps(store) && !hasSourceAudioToWatch(store)) {
        return;
    }

    try {
        if (!(await shouldStartWatcherForRecording())) {
            log.info({ meeting: meetingId }, "no watcher at the meeting end: a scratch store with autostart off");
            return;
        }

        await ensureWatcher();
    } catch (err) {
        log.warn({ err, meeting: meetingId }, "the watcher that reads the project answer back did not start");
    }
}

export { claimWatcher } from "../lib/watcher";

async function watch(opts: { once?: boolean }): Promise<void> {
    const store = new MeetingStore();

    try {
        if (opts.once) {
            ui.info(await watchOnce(store));
            return;
        }

        await runWatcher(store);
    } catch (err) {
        fail(err);
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

    if (!picked) {
        return;
    }

    try {
        const { enabled, running, lastFailure } = await recordingAutostart(picked);
        ui.ok(
            `Recording starts with Wispr Flow: ${enabled ? "on" : "off"}. Watcher: ${running ? "running" : "not running"}.`
        );
        if (lastFailure) {
            ui.warn(
                `Last recording failure at ${localTime(lastFailure.at)} · ${lastFailure.meeting}: ${lastFailure.problem}\nRun: ${lastFailure.fix}\nNotification delivery: ${lastFailure.confirmed ? "confirmed" : "unconfirmed"}.`
            );
        }
    } catch (err) {
        fail(err);
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
