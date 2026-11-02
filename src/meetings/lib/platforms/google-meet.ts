import type { MeetingPlatform } from "@genesiscz/utils/meetings/platform";

/**
 * Google Meet in a browser. Wispr reads its speaking indicator (measured 2026-11-02: 64 to 878 readings per meeting),
 * but nothing on this Mac keeps who joined or left when.
 */
export const googleMeetPlatform: MeetingPlatform = {
    id: "google-meet",
    label: "Google Meet",
    capabilities: { attendance: "none", speaking: true },
    sourceNames: ["google_meet"],

    async attendance() {
        return null;
    },
};
