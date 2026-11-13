import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { type AcousticShare, echoForRange, readEchoCache } from "@genesiscz/utils/meetings/echo";
import {
    type ChannelCalibration,
    calibrateChannels,
    micShare,
    readCachedChannelEnergy,
    type SilentCallSpan,
    silentCallSpans,
} from "@genesiscz/utils/meetings/energy";
import type { MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import type { MeetingEvidence } from "@genesiscz/utils/meetings/sources";
import { voiceEvidenceSchema } from "@genesiscz/utils/meetings/voice";

const { log } = logger.scoped("meetings-energy");

export interface MicEnergy {
    /** The microphone channel's energy share per time range; undefined when the layout is unknown. */
    share?: AcousticShare;
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

    const energy = readCachedChannelEnergy(join(store.folder(record.id), "evidence", "energy.bin"), evidence.audioPath);

    if (!energy) {
        return {};
    }

    const calibration = calibrateChannels(energy, evidence.segments);
    log.debug({ meeting: record.id, ...calibration }, "channel layout calibrated");
    const { layout } = calibration;
    const echo = await readEchoCache({
        audioPath: evidence.audioPath,
        cachePath: join(store.folder(record.id), "evidence", "echo.json"),
        layout,
    });
    const folder = join(store.folder(record.id), "evidence");
    const voicesPath = join(folder, "voice-scores.json"),
        enrolmentPath = join(folder, "voices.json");
    const voices = existsSync(voicesPath)
        ? voiceEvidenceSchema.safeParse(SafeJSON.parse(readFileSync(voicesPath, "utf8")))
        : undefined;
    const stat = statSync(evidence.audioPath);
    const validVoices =
        voices?.success &&
        voices.data.source === SafeJSON.stringify([evidence.audioPath, stat.size, stat.mtimeMs]) &&
        existsSync(enrolmentPath) &&
        voices.data.enrolment === Bun.hash(readFileSync(enrolmentPath)).toString()
            ? voices.data.lines
            : undefined;
    const share: AcousticShare = Object.assign(
        (fromSec: number, toSec: number) => (echo ? echoForRange(echo, fromSec, toSec)?.cleanMicShare : undefined),
        {
            acoustic: (fromSec: number, toSec: number) => (echo ? echoForRange(echo, fromSec, toSec) : undefined),
            voice: (fromSec: number, toSec: number) => validVoices?.[`${fromSec}:${toSec}`],
        }
    );
    share.raw = (fromSec, toSec) => micShare(energy, layout, fromSec, toSec);
    return {
        calibration,
        ...(layout === "unknown" ? {} : { share }),
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

    log.debug({ meeting: record.id, layout: channels.layout, silent: channels.callSilent.length }, "channels stored");
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
