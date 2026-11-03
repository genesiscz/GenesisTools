import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import {
    type ChannelCalibration,
    calibrateChannels,
    channelEnergy,
    micShare,
    type SilentCallSpan,
    silentCallSpans,
} from "@genesiscz/utils/meetings/energy";
import type { MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import type { MeetingEvidence } from "@genesiscz/utils/meetings/sources";

const { log } = logger.scoped("meetings-energy");

export interface MicEnergy {
    /** The microphone channel's energy share per time range; undefined when the layout is unknown. */
    share?: (fromSec: number, toSec: number) => number | undefined;
    calibration?: ChannelCalibration;
}

/**
 * The meeting's audio energy (cached in its record folder as `evidence/energy.bin`), with the channel layout
 * calibrated on the recorder's tagged segments. Reads only: storing the calibration is `storeCalibration`. Nothing
 * when the source keeps no audio or ffmpeg is missing.
 */
export async function energyMicShareFor(
    store: MeetingStore,
    record: MeetingRecord,
    evidence: MeetingEvidence | null
): Promise<MicEnergy> {
    if (!evidence?.audioPath) {
        return {};
    }

    const energy = await channelEnergy(evidence.audioPath, join(store.folder(record.id), "evidence", "energy.bin"));

    if (!energy) {
        return {};
    }

    const calibration = calibrateChannels(energy, evidence.segments);
    log.debug({ meeting: record.id, ...calibration }, "channel layout calibrated");
    const { layout } = calibration;
    return {
        calibration,
        ...(layout === "unknown"
            ? {}
            : { share: (fromSec: number, toSec: number) => micShare(energy, layout, fromSec, toSec) }),
    };
}

/** The stretches where the call's channel stayed silent, over the transcript; none without a calibrated share. */
export function callSilentSpans(energy: MicEnergy, endSec: number): SilentCallSpan[] {
    return energy.share && endSec > 0 ? silentCallSpans(energy.share, 0, endSec) : [];
}

/** Stores the calibration and the silent call stretches as `evidence.channels` when they changed. */
export async function storeCalibration(options: {
    store: MeetingStore;
    record: MeetingRecord;
    calibration: ChannelCalibration;
    callSilent: SilentCallSpan[];
}): Promise<MeetingRecord> {
    const { store, record } = options;
    const channels = { ...options.calibration, callSilent: options.callSilent };

    if (SafeJSON.stringify(record.evidence?.channels) === SafeJSON.stringify(channels)) {
        return record;
    }

    log.info({ meeting: record.id, layout: channels.layout, silent: channels.callSilent.length }, "channels stored");
    return store.update(
        record.id,
        {
            command: "calibrate",
            change: `channels ${channels.layout}, ${channels.callSilent.length} silent call stretches`,
        },
        (current) => {
            current.evidence = { ...current.evidence, channels };
        }
    );
}
