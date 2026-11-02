import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { type ChannelCalibration, calibrateChannels, channelEnergy, micShare } from "@genesiscz/utils/meetings/energy";
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
 * calibrated on the recorder's tagged segments and stored in the record as `evidence.channels` when it changed.
 * Nothing when the source keeps no audio or ffmpeg is missing.
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
    log.info({ meeting: record.id, ...calibration }, "channel layout calibrated");

    if (SafeJSON.stringify(record.evidence?.channels) !== SafeJSON.stringify(calibration)) {
        await store.update(record.id, { command: "calibrate", change: `channels ${calibration.layout}` }, (current) => {
            current.evidence = { ...current.evidence, channels: calibration };
        });
    }

    const { layout } = calibration;
    return {
        calibration,
        ...(layout === "unknown"
            ? {}
            : { share: (fromSec: number, toSec: number) => micShare(energy, layout, fromSec, toSec) }),
    };
}
