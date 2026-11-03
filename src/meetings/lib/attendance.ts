import { existsSync, readFileSync } from "node:fs";
import {
    type AttendanceTarget,
    isMeetingPlatformId,
    MEETING_PLATFORM_IDS,
    type MeetingPlatform,
    type MeetingPlatformId,
    type PlatformAttendance,
} from "@genesiscz/utils/meetings/platform";
import { MEETING_PLATFORMS } from "./platforms";

export type { AttendanceTarget };
export type LoadedPresence = PlatformAttendance;

/** `teams:/path/file.json` names the platform whose format a file is in. */
function platformFilePrefix(spec: string): { platform: MeetingPlatform; path: string } | undefined {
    const match = /^([a-z-]+):(.+)$/.exec(spec);

    if (!match || !isMeetingPlatformId(match[1]!)) {
        return undefined;
    }

    return { platform: MEETING_PLATFORMS[match[1]!], path: match[2]! };
}

/**
 * The platform whose export format a file is in: the one its `<platform>:` prefix names, else the meeting's own
 * platform when the text fits its format, else the one platform whose reader recognizes the text. Throws when none or
 * several do.
 */
function fileReader(
    raw: string,
    path: string,
    choice: { named?: MeetingPlatform; meeting?: MeetingPlatform }
): MeetingPlatform {
    if (choice.named) {
        if (!choice.named.attendanceFile) {
            throw new Error(`${choice.named.label} has no attendance file format; give the platform id instead.`);
        }

        return choice.named;
    }

    if (choice.meeting?.attendanceFile?.reads(raw)) {
        return choice.meeting;
    }

    const readers = Object.values(MEETING_PLATFORMS).filter((one) => one.attendanceFile?.reads(raw));

    if (readers.length === 1) {
        return readers[0]!;
    }

    const known = Object.values(MEETING_PLATFORMS)
        .flatMap((one) => (one.attendanceFile ? [`${one.id}: ${one.attendanceFile.format}`] : []))
        .join("; ");
    throw new Error(
        readers.length === 0
            ? `${path} is in no known attendance format (${known})`
            : `${path} fits ${readers.map((one) => one.id).join(" and ")}; prefix it with the platform, e.g. ${readers[0]!.id}:${path}`
    );
}

/**
 * Attendance from a platform (`teams`, `facetime`, …), or from a file in a platform's export format: `teams:<file>`,
 * or a bare path read in the meeting's platform's format (`platform`), else in the one format the text fits. Throws
 * when the platform keeps no such call, or keeps no attendance at all.
 */
export async function loadPresence(
    meeting: AttendanceTarget,
    spec: string,
    platform?: MeetingPlatformId
): Promise<LoadedPresence> {
    if (isMeetingPlatformId(spec)) {
        const named = MEETING_PLATFORMS[spec];

        if (named.capabilities.attendance === "none") {
            throw new Error(`${named.label} keeps no attendance on this Mac.`);
        }

        const loaded = await named.attendance(meeting);

        if (!loaded) {
            throw new Error(`${named.label}: no call near ${meeting.start}.`);
        }

        return loaded;
    }

    const prefixed = existsSync(spec) ? undefined : platformFilePrefix(spec);
    const path = prefixed?.path ?? spec;

    if (!existsSync(path)) {
        throw new Error(`--attendance ${spec}: no such file, and not a platform (${MEETING_PLATFORM_IDS.join(", ")})`);
    }

    const raw = readFileSync(path, "utf8");
    const reader = fileReader(raw, path, {
        ...(prefixed ? { named: prefixed.platform } : {}),
        ...(platform ? { meeting: MEETING_PLATFORMS[platform] } : {}),
    });
    const loaded = reader.attendanceFile!.attendance(raw, meeting, path);

    if (!loaded) {
        throw new Error(`${path}: no ${reader.label} call starts within 30 minutes of ${meeting.start}`);
    }

    return loaded;
}
