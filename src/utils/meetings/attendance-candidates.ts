import { formatLocalDateTimeStamp } from "@genesiscz/utils/date";
import { z } from "zod";

/** The exit-1 JSON response of the Teams attendance reader when a query needs a chat id. */
export const attendanceCandidatesSchema = z.object({
    status: z.enum(["ambiguous", "none"]),
    candidates: z.array(
        z.object({
            id: z.string(),
            title: z.string(),
            lastCallAt: z.iso.datetime({ offset: true }).nullable(),
            participantCount: z.number().int().nonnegative(),
            command: z.string(),
        })
    ),
});

export type AttendanceCandidates = z.infer<typeof attendanceCandidatesSchema>;

export function formatAttendanceCandidates(candidates: AttendanceCandidates["candidates"]): string {
    if (!candidates.length) {
        return "No matching meeting chats in the Teams cache.";
    }

    const lines = candidates.map(({ id, title, lastCallAt, participantCount, command }) => {
        const lastCall = lastCallAt === null ? "unknown" : formatLocalDateTimeStamp(lastCallAt);
        return `${title} (${id}) · last call ${lastCall} · ${participantCount} participant${participantCount === 1 ? "" : "s"}\n  ${command}`;
    });
    return ["Could not resolve a single meeting chat. Matching chats, newest call first:", ...lines].join("\n");
}
