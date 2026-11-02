import { existsSync, readFileSync } from "node:fs";
import { execTool } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { Presence } from "@genesiscz/utils/transcribe/speakers";
import { z } from "zod";

/** The meeting the attendance is for: its title (the Teams chat is found by it) and its start (transcript second 0). */
export interface AttendanceTarget {
    title: string;
    start: string;
}

const { log } = logger.scoped("meetings-attendance");

/** A Teams call more than this far from the meeting's start is another occurrence of the meeting. */
const SAME_CALL_WITHIN_MS = 30 * 60_000;
const TEAMS_TIMEOUT_MS = 60_000;

/** The part of `tools ms-teams meetings attendance --json` this reads. */
const attendanceSchema = z.array(
    z.object({
        meeting: z.object({ title: z.string().nullish(), startedAt: z.string().nullish() }),
        attendance: z.array(
            z.object({
                name: z.string(),
                self: z.boolean().optional(),
                joinedAt: z.string().nullish(),
                leftAt: z.string().nullish(),
            })
        ),
    })
);
type AttendanceCall = z.infer<typeof attendanceSchema>[number];

export interface LoadedPresence {
    presence: Presence[];
    /** Where it came from and which call, for the user. */
    note: string;
}

async function readCalls(spec: string, meeting: AttendanceTarget): Promise<{ raw: string; from: string }> {
    if (spec !== "teams") {
        if (!existsSync(spec)) {
            throw new Error(`--attendance ${spec}: no such file (or use --attendance teams)`);
        }

        return { raw: readFileSync(spec, "utf8"), from: spec };
    }

    // Another tool, with its own data and its own privacy identity, so it runs as its own process.
    const result = await execTool(["ms-teams", "meetings", "attendance", meeting.title, "--json"], {
        timeout: TEAMS_TIMEOUT_MS,
    });
    log.debug({ title: meeting.title, exitCode: result.exitCode }, "ms-teams attendance");

    if (!result.success) {
        throw new Error(
            `${toolCommand("ms-teams", "meetings", "attendance")} failed: ${result.stderr || `exit ${result.exitCode}`}`
        );
    }

    return { raw: result.stdout, from: toolCommand("ms-teams") };
}

/** The call that started closest to the meeting, if one is close enough to be the same call. */
function closestCall(calls: AttendanceCall[], startMs: number): AttendanceCall | undefined {
    const timed = calls
        .map((call) => ({ call, gap: Math.abs(Date.parse(call.meeting.startedAt ?? "") - startMs) }))
        .filter((entry) => Number.isFinite(entry.gap))
        .sort((a, b) => a.gap - b.gap);

    return timed[0] && timed[0].gap <= SAME_CALL_WITHIN_MS ? timed[0].call : undefined;
}

/**
 * Teams attendance for a meeting, on the transcript clock: second 0 is the meeting's `start` (checked 2026-11-02 for
 * Wispr Flow: every confirmed goodbye fell within 4 s of a Teams leave time).
 */
export async function loadPresence(meeting: AttendanceTarget, spec: string): Promise<LoadedPresence> {
    const { raw, from } = await readCalls(spec, meeting);
    const calls = attendanceSchema.parse(SafeJSON.parse(raw, { strict: true }));
    const startMs = Date.parse(meeting.start);
    const call = closestCall(calls, startMs);

    if (!call) {
        throw new Error(`${from}: no call starts within 30 minutes of ${meeting.start} (${calls.length} calls read)`);
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
