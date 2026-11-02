import type { Presence } from "@genesiscz/utils/transcribe/speakers";

/** The call platforms a meeting can run on. A new platform is an id here and one implementation in the tool. */
export const MEETING_PLATFORM_IDS = ["teams", "facetime", "google-meet"] as const;
export type MeetingPlatformId = (typeof MEETING_PLATFORM_IDS)[number];

export function isMeetingPlatformId(value: string): value is MeetingPlatformId {
    return (MEETING_PLATFORM_IDS as readonly string[]).includes(value);
}

/** What a platform can tell about a call. */
export interface PlatformCapabilities {
    /**
     * `per-person`: each person's join and leave times. `whole-call`: who was in the call, each for all of it.
     * `none`: nothing.
     */
    attendance: "per-person" | "whole-call" | "none";
    /** Whether the source records the platform's speaking indicator; rule E3 reads it only then. */
    speaking: boolean;
}

/** The meeting an attendance is for: its title (some platforms find the call by it), start and end. */
export interface AttendanceTarget {
    title: string;
    /** Transcript second 0. */
    start: string;
    end?: string;
}

export interface PlatformAttendance {
    /** On the transcript clock; an open stay ends at `Infinity`. */
    presence: Presence[];
    /** Where it came from and which call, for the user. */
    note: string;
}

export interface MeetingPlatform {
    id: MeetingPlatformId;
    label: string;
    capabilities: PlatformCapabilities;
    /** The names sources use for this platform (Wispr's `meta.platform`). */
    sourceNames: readonly string[];
    /** Who was in the call and when; null when the platform keeps no such call. Throws when it cannot be read. */
    attendance(target: AttendanceTarget): Promise<PlatformAttendance | null>;
}
