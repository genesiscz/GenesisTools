import { existsSync, readFileSync } from "node:fs";
import {
    type AttendanceTarget,
    isMeetingPlatformId,
    MEETING_PLATFORM_IDS,
    type PlatformAttendance,
} from "@genesiscz/utils/meetings/platform";
import { MEETING_PLATFORMS } from "./platforms";
import { teamsAttendanceFromJson } from "./platforms/teams";

export type { AttendanceTarget };
export type LoadedPresence = PlatformAttendance;

/**
 * Attendance from a platform (`teams`, `facetime`, …) or from a file of `tools ms-teams meetings attendance --json`
 * output. Throws when the platform keeps no such call, or keeps no attendance at all.
 */
export async function loadPresence(meeting: AttendanceTarget, spec: string): Promise<LoadedPresence> {
    if (isMeetingPlatformId(spec)) {
        const platform = MEETING_PLATFORMS[spec];

        if (platform.capabilities.attendance === "none") {
            throw new Error(`${platform.label} keeps no attendance on this Mac.`);
        }

        const loaded = await platform.attendance(meeting);

        if (!loaded) {
            throw new Error(`${platform.label}: no call near ${meeting.start}.`);
        }

        return loaded;
    }

    if (!existsSync(spec)) {
        throw new Error(`--attendance ${spec}: no such file, and not a platform (${MEETING_PLATFORM_IDS.join(", ")})`);
    }

    const loaded = teamsAttendanceFromJson(readFileSync(spec, "utf8"), meeting, spec);

    if (!loaded) {
        throw new Error(`${spec}: no call starts within 30 minutes of ${meeting.start}`);
    }

    return loaded;
}
