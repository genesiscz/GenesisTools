import { logger } from "@genesiscz/utils/logger";
import type { MeetingStore } from "@genesiscz/utils/meetings/record";
import { askAtMeetingEnd, hasOpenAssignSteps } from "./assign";
import { hasSourceAudioToWatch } from "./watch";
import { ensureWatcher, shouldStartWatcherForRecording } from "./watcher";

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
