import { join } from "node:path";
import { channelEnergy, energyShare } from "@genesiscz/utils/meetings/energy";
import type { MeetingStore } from "@genesiscz/utils/meetings/record";
import type { MeetingEvidence } from "@genesiscz/utils/meetings/sources";

/**
 * The microphone channel's energy share per time range, from the meeting's audio, cached in its record folder
 * (`evidence/energy.bin`). Undefined when the source keeps no audio or ffmpeg is missing.
 */
export async function energyLeftShareFor(
    store: MeetingStore,
    meetingId: string,
    evidence: MeetingEvidence | null
): Promise<((fromSec: number, toSec: number) => number | undefined) | undefined> {
    if (!evidence?.audioPath) {
        return undefined;
    }

    const energy = await channelEnergy(evidence.audioPath, join(store.folder(meetingId), "evidence", "energy.bin"));
    return energy ? (fromSec, toSec) => energyShare(energy, fromSec, toSec).share : undefined;
}
