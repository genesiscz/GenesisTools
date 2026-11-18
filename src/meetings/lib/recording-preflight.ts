import type { readLivePermissions } from "@app/control/lib/permissions";
import { mutateWidgetState } from "@app/hub/lib/widget/storage";
import type { MeetingStore } from "@genesiscz/utils/meetings/record";

const HOUR_MS = 60 * 60_000;
const checked = new WeakMap<MeetingStore, { at: number; enabled: boolean; needsMic: boolean; cardEnabled: boolean }>();

export async function showRecordingGrantCard(reason?: string, widgetRoot?: string): Promise<void> {
    await mutateWidgetState(widgetRoot, (state) => {
        if (reason) {
            state.meetingRecordingWarning = reason;
        } else {
            delete state.meetingRecordingWarning;
        }
    });
}

/** A new watcher checks immediately. Changing the enabled sources invalidates the hour's result. */
export async function checkRecordingGrants(
    store: MeetingStore,
    options: {
        enabled: boolean;
        needsMic: boolean;
        cardEnabled: boolean;
        now: number;
        read: typeof readLivePermissions;
        show: (reason?: string) => Promise<void>;
    }
): Promise<void> {
    const { enabled, needsMic, cardEnabled, now, read, show } = options;
    const prior = checked.get(store);
    if (
        prior?.enabled === enabled &&
        prior.needsMic === needsMic &&
        prior.cardEnabled === cardEnabled &&
        (!enabled || (now >= prior.at && now - prior.at < HOUR_MS))
    ) {
        return;
    }
    let reason: string | undefined;
    if (enabled) {
        const { live, error } = read();
        if (!live) {
            reason = `could not read the grant: ${error ?? "missing live result"}`;
        } else {
            const missing: string[] = [];
            if (!live.screenRecording) {
                missing.push("Screen Recording");
            }
            if (needsMic && live.microphone !== true) {
                missing.push(live.microphone === false ? "Microphone" : "could not read the grant for Microphone");
            }
            reason = missing.join(", ") || undefined;
        }
    }
    await show(cardEnabled ? reason : undefined);
    checked.set(store, { at: now, enabled, needsMic, cardEnabled });
}
