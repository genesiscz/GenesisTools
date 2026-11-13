import { execTool } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import {
    type AttendanceTarget,
    AttendanceUnavailableError,
    type MeetingPlatform,
    type PlatformAttendance,
} from "@genesiscz/utils/meetings/platform";
import type { Presence } from "@genesiscz/utils/transcribe/speakers";
import { z } from "zod";

const { log } = logger.scoped("meetings-teams");

/** A Teams call more than this far from the meeting's start is another occurrence of the meeting. */
const SAME_CALL_WITHIN_MS = 30 * 60_000;
const TEAMS_TIMEOUT_MS = 60_000;

/** The part of `tools ms-teams meetings attendance --json` this reads. */
const attendanceSchema = z.array(
    z.object({
        meeting: z.object({
            title: z.string().nullish(),
            startedAt: z.string().nullish(),
            endedAt: z.string().nullish(),
        }),
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
        // A call still running has no "call ended" message, so no startedAt: the observer's join stands in for it.
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

    // The call-ended message lists who took part without join or leave times: they count as present for the whole
    // call, which still names the candidates (rule E2) and who was there at all (rule RA).
    const callFrom = Date.parse(call.meeting.startedAt ?? "");
    const callTo = Date.parse(call.meeting.endedAt ?? "");
    let untimed = 0;
    const presence: Presence[] = call.attendance.flatMap((person) => {
        const joinedAt = Date.parse(person.joinedAt ?? "");
        const leftAt = Date.parse(person.leftAt ?? "");
        const joined = Number.isFinite(joinedAt) ? joinedAt : callFrom;
        const left = Number.isFinite(leftAt) ? leftAt : Number.isFinite(joinedAt) ? Number.NaN : callTo;

        if (!Number.isFinite(joined)) {
            return [];
        }

        untimed += Number.isFinite(joinedAt) ? 0 : 1;

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
    const title = call.meeting.title ?? "untitled";
    const listed = call.attendance.length;

    if (listed === 0) {
        return { presence, note: `attendance: Teams keeps no participant list for "${title}"` };
    }

    const missing = listed - presence.length;
    const notes = [
        untimed > 0 ? `${untimed} without join or leave times, counted present for the whole call` : "",
        missing > 0 ? `${missing} left out: neither they nor the call have a start time` : "",
    ].filter(Boolean);

    return {
        presence,
        note: `attendance: ${presence.length} people from ${from} ("${title}")${notes.length ? `; ${notes.join("; ")}` : ""}`,
    };
}

/** Whether a text is `tools ms-teams meetings attendance --json` output. */
function readsTeamsAttendance(raw: string): boolean {
    try {
        return attendanceSchema.safeParse(SafeJSON.parse(raw, { strict: true })).success;
    } catch {
        return false;
    }
}

async function readTeams(args: string[]) {
    try {
        return await execTool(args, { timeout: TEAMS_TIMEOUT_MS });
    } catch (cause) {
        throw new AttendanceUnavailableError("Teams attendance reader failed", { cause });
    }
}

/** Diagnostic candidates only: never select a chat from this list. */
async function candidateChats(target: AttendanceTarget): Promise<string> {
    try {
        const result = await readTeams(["ms-teams", "meetings", "list", "--json"]);
        if (!result.success) {
            return "Candidate chats unavailable; use --attendance-id <threadId> with a known chat id.";
        }

        const rows = z
            .array(z.object({ id: z.string(), title: z.string(), lastMessageTime: z.number().nullable() }))
            .parse(SafeJSON.parse(result.stdout, { strict: true }));
        const start = Date.parse(target.start);
        rows.sort(
            (a, b) =>
                Math.abs((a.lastMessageTime ?? Infinity) - start) - Math.abs((b.lastMessageTime ?? Infinity) - start)
        );
        return rows.length
            ? `Closest cached chats by last message time (not call start); select with --attendance-id <threadId>:\n${rows
                  .slice(0, 8)
                  .map((row) => `${row.id}  ${row.title}`)
                  .join("\n")}`
            : "No cached meeting chats; use --attendance-id <threadId> with a known chat id.";
    } catch (error) {
        log.debug({ error }, "candidate chats unavailable");
        return "Candidate chats unavailable; use --attendance-id <threadId> with a known chat id.";
    }
}

export const teamsPlatform: MeetingPlatform = {
    id: "teams",
    label: "Microsoft Teams",
    capabilities: { attendance: "per-person", speaking: true },
    sourceNames: ["teams"],

    attendanceSelection: "id",

    async attendance(target, selection) {
        // Another tool, with its own data and its own privacy identity, so it runs as its own process.
        const args = selection ? ["--id", selection.id] : [target.title];
        const result = await readTeams(["ms-teams", "meetings", "attendance", ...args, "--json"]);
        log.debug({ title: target.title, exitCode: result.exitCode }, "ms-teams attendance");

        if (!result.success) {
            // ms-teams says why on stdout ("Could not resolve a single meeting chat. Pass --id."), not on stderr.
            const reason = result.stderr.trim() || result.stdout.trim();
            const candidates = await candidateChats(target);
            throw new AttendanceUnavailableError(
                `${toolCommand("ms-teams", "meetings", "attendance")} "${target.title}" failed: ${reason || `exit ${result.exitCode}`}\n${candidates}`
            );
        }

        return teamsAttendanceFromJson(result.stdout, target, toolCommand("ms-teams"));
    },

    attendanceFile: {
        format: `${toolCommand("ms-teams", "meetings", "attendance", "--json")} output`,
        reads: readsTeamsAttendance,
        attendance: teamsAttendanceFromJson,
    },
};
