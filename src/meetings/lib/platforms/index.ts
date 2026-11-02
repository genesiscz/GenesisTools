import type { MeetingPlatform, MeetingPlatformId } from "@genesiscz/utils/meetings/platform";
import type { MeetingRecord } from "@genesiscz/utils/meetings/record";
import type { MeetingEvidence } from "@genesiscz/utils/meetings/sources";
import { faceTimePlatform } from "./facetime";
import { googleMeetPlatform } from "./google-meet";
import { teamsPlatform } from "./teams";

/** One entry per platform; a missing one is a compile error. */
export const MEETING_PLATFORMS: Record<MeetingPlatformId, MeetingPlatform> = {
    teams: teamsPlatform,
    facetime: faceTimePlatform,
    "google-meet": googleMeetPlatform,
};

/** The platform a source names (Wispr's `meta.platform`), if any is known by that name. */
export function platformOfSourceName(name: string | undefined): MeetingPlatform | undefined {
    return name ? Object.values(MEETING_PLATFORMS).find((platform) => platform.sourceNames.includes(name)) : undefined;
}

/** The evidence rule E3 may read: none of the speaking readings when the record's platform has no speaking indicator. */
export function speakingEvidence(record: MeetingRecord, evidence: MeetingEvidence | null): MeetingEvidence | null {
    if (!evidence || !record.platform || MEETING_PLATFORMS[record.platform].capabilities.speaking) {
        return evidence;
    }

    return { ...evidence, speaking: [] };
}
