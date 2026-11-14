import { MeetingStore } from "@genesiscz/utils/meetings/record";
import { MEETING_SOURCE_IDS } from "@genesiscz/utils/meetings/sources";
import type { LiveSourceMeeting, LocalSourceAudio } from "./source-audio-discovery";
import {
    applySourceAudioPlan,
    planSourceAudio,
    type SourceAudioPlan,
    sourceAudioPlanSchema,
} from "./source-audio-discovery";
import { liveSourceMeetingId, localSourceAudio } from "./sources";

/**
 * Every provider input of a plan or an apply: the local audio adapters and the live-recording lookup together, so an
 * isolated caller (a test) cannot supply its own catalogs and still have this Mac's provider decide what is live.
 */
export interface LocalSourceAudioAccess {
    sources: LocalSourceAudio[];
    live: LiveSourceMeeting;
}

async function inputs(store: MeetingStore, supplied?: LocalSourceAudioAccess) {
    if (supplied) {
        return { store, ...supplied };
    }

    return {
        store,
        sources: await Promise.all(MEETING_SOURCE_IDS.map(localSourceAudio)),
        live: liveSourceMeetingId,
    };
}

export interface LocalSourceAudioOptions {
    store?: MeetingStore;
    /** Isolated provider access; this Mac's providers by default. */
    local?: LocalSourceAudioAccess;
}

export async function planLocalSourceAudio(options: LocalSourceAudioOptions = {}): Promise<SourceAudioPlan> {
    return planSourceAudio(await inputs(options.store ?? new MeetingStore(), options.local));
}

export async function applyLocalSourceAudio(options: LocalSourceAudioOptions & { plan: SourceAudioPlan }) {
    const store = options.store ?? new MeetingStore();
    const plan = sourceAudioPlanSchema.parse(options.plan);
    if (plan.meetingsRoot !== store.root) {
        throw new Error("The audio plan belongs to a different meetings store.");
    }
    return applySourceAudioPlan({ ...(await inputs(store, options.local)), plan });
}
