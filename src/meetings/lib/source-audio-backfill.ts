import { MeetingStore } from "@genesiscz/utils/meetings/record";
import { MEETING_SOURCE_IDS, type MeetingSourceId } from "@genesiscz/utils/meetings/sources";
import type { LocalSourceAudio } from "./source-audio-discovery";
import {
    applySourceAudioPlan,
    planSourceAudio,
    type SourceAudioPlan,
    sourceAudioPlanSchema,
} from "./source-audio-discovery";
import { localSourceAudio, meetingSource } from "./sources";

async function inputs(store: MeetingStore, supplied?: LocalSourceAudio[]) {
    const sources = supplied ?? (await Promise.all(MEETING_SOURCE_IDS.map(localSourceAudio)));
    const live: Partial<Record<MeetingSourceId, string>> = {};
    for (const { id } of sources) {
        const recording = await (await meetingSource(id)).liveRecording();
        if (recording) {
            live[id] = recording.sourceMeetingId;
        }
    }
    return { store, sources, live };
}

export interface LocalSourceAudioOptions {
    store?: MeetingStore;
    sources?: LocalSourceAudio[];
}

export async function planLocalSourceAudio(options: LocalSourceAudioOptions = {}): Promise<SourceAudioPlan> {
    return planSourceAudio(await inputs(options.store ?? new MeetingStore(), options.sources));
}

export async function applyLocalSourceAudio(options: LocalSourceAudioOptions & { plan: SourceAudioPlan }) {
    const store = options.store ?? new MeetingStore();
    const plan = sourceAudioPlanSchema.parse(options.plan);
    if (plan.meetingsRoot !== store.root) {
        throw new Error("The audio plan belongs to a different meetings store.");
    }
    return applySourceAudioPlan({ ...(await inputs(store, options.sources)), plan });
}
