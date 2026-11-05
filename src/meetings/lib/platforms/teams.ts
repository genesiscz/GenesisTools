import { execTool } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { AttendanceTarget, MeetingPlatform, PlatformAttendance } from "@genesiscz/utils/meetings/platform";
import type { Presence } from "@genesiscz/utils/transcribe/speakers";
import { z } from "zod";

const { log } = logger.scoped("meetings-teams");

/** A Teams call more than this far from the meeting's start is another occurrence of the meeting. */
const SAME_CALL_WITHIN_MS = 30 * 60_000;
const TEAMS_TIMEOUT_MS = 60_000;

/** The part of `tools ms-teams meetings attendance --json` this reads. */
const attendanceSchema = z.array(
    z.object({
        meeting: z.object({ title: z.string().nullish(), startedAt: z.string().nullish() }),
        observer: z.object({ joinedAt: z.string().nullish() }).optional(),
        attendance: z.array(
            z.object({
                name: z.string(),
                self: z.boolean().optional(),
                joinedAt: z.string().nullish(),
                leftAt: z.string().nullish(),
                joinedAtExact: z.boolean().optional(),
                leftAtExact: z.boolean().optional(),
            })
        ),
    })
);
type AttendanceCall = z.infer<typeof attendanceSchema>[number];

/** The call that started closest to the meeting, if one is close enough to be the same call. */
function closestCall(calls: AttendanceCall[], startMs: number): AttendanceCall | undefined {
    const timed = calls
        .map((call) => ({
            call,
            gap: Math.abs(Date.parse(call.meeting.startedAt ?? call.observer?.joinedAt ?? "") - startMs),
        }))
        .filter((entry) => Number.isFinite(entry.gap))
        .sort((a, b) => a.gap - b.gap);

    return timed[0] && timed[0].gap <= SAME_CALL_WITHIN_MS ? timed[0].call : undefined;
}

/**
 * Teams attendance from `tools ms-teams meetings attendance --json` output, on the transcript clock: second 0 is the
 * meeting's `start` (checked 2026-11-02 for Wispr Flow: every confirmed goodbye fell within 4 s of a Teams leave time).
 */
export function teamsAttendanceFromJson(
    raw: string,
    target: AttendanceTarget,
    from: string
): PlatformAttendance | null {
    const calls = attendanceSchema.parse(SafeJSON.parse(raw, { strict: true }));
    const startMs = Date.parse(target.start);
    const call = closestCall(calls, startMs);

    if (!call) {
        log.info({ from, calls: calls.length, start: target.start }, "no Teams call within 30 minutes");
        return null;
    }

    const presence: Presence[] = call.attendance.flatMap((person) => {
        const joined = Date.parse(person.joinedAt ?? "");
        const left = Date.parse(person.leftAt ?? "");

        if (!Number.isFinite(joined)) {
            return [];
        }

        return [
            {
                name: person.name,
                ...(person.self ? { self: true } : {}),
                ...(person.joinedAtExact !== undefined ? { joinedAtExact: person.joinedAtExact } : {}),
                ...(person.leftAtExact !== undefined ? { leftAtExact: person.leftAtExact } : {}),
                fromSec: (joined - startMs) / 1000,
                toSec: Number.isFinite(left) ? (left - startMs) / 1000 : Number.POSITIVE_INFINITY,
            },
        ];
    });

    return {
        presence,
        note: `attendance: ${presence.length} people from ${from} ("${call.meeting.title ?? "untitled"}")`,
    };
}

export const teamsPlatform: MeetingPlatform = {
    id: "teams",
    label: "Microsoft Teams",
    capabilities: { attendance: "per-person", speaking: true },
    sourceNames: ["teams"],

    async attendance(target) {
        // Another tool, with its own data and its own privacy identity, so it runs as its own process.
        const result = await execTool(["ms-teams", "meetings", "attendance", target.title, "--json"], {
            timeout: TEAMS_TIMEOUT_MS,
        });
        log.debug({ title: target.title, exitCode: result.exitCode }, "ms-teams attendance");

        if (!result.success) {
            throw new Error(
                `${toolCommand("ms-teams", "meetings", "attendance")} failed: ${result.stderr || `exit ${result.exitCode}`}`
            );
        }

        return teamsAttendanceFromJson(result.stdout, target, toolCommand("ms-teams"));
    },
};
