import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import { MacContactsDatabase } from "@genesiscz/utils/macos/MacContactsDatabase";
import type { AttendanceTarget, MeetingPlatform, PlatformAttendance } from "@genesiscz/utils/meetings/platform";
import type { Presence } from "@genesiscz/utils/transcribe/speakers";

const { log } = logger.scoped("meetings-facetime");

/** Core Data counts seconds from 2001-01-01. */
const CORE_DATA_EPOCH_SEC = 978_307_200;
/** A call that starts more than this far from the meeting is another call. */
const SAME_CALL_WITHIN_SEC = 15 * 60;

interface CallRow {
    pk: number;
    startSec: number;
    durationSec: number;
    name: string | null;
}

function callHistoryPath(): string {
    return join(env.tools.getHome(), "Library", "Application Support", "CallHistoryDB", "CallHistory.storedata");
}

/** The FaceTime calls starting near the meeting, with their remote handles. Read-only. */
function readCalls(startSec: number): Array<CallRow & { handles: string[] }> {
    const path = callHistoryPath();

    if (!existsSync(path)) {
        throw new Error(`No call history at ${path}.`);
    }

    let db: Database;

    try {
        db = new Database(path, { readonly: true });
    } catch (err) {
        throw new Error(
            `The call history cannot be read (${String(err)}). It needs Full Disk Access: ${toolCommand("macos", "permissions")}`
        );
    }

    try {
        const from = startSec - SAME_CALL_WITHIN_SEC - CORE_DATA_EPOCH_SEC;
        const to = startSec + SAME_CALL_WITHIN_SEC - CORE_DATA_EPOCH_SEC;
        const calls = db
            .query<{ pk: number; date: number; duration: number; name: string | null }, [number, number]>(
                `SELECT Z_PK AS pk, ZDATE AS date, ZDURATION AS duration, ZNAME AS name FROM ZCALLRECORD
                 WHERE ZSERVICE_PROVIDER = 'com.apple.FaceTime' AND ZDATE BETWEEN ? AND ?`
            )
            .all(from, to);
        const handles = db.query<{ value: string | null }, [number]>(
            `SELECT h.ZVALUE AS value FROM Z_2REMOTEPARTICIPANTHANDLES j JOIN ZHANDLE h ON h.Z_PK = j.Z_4REMOTEPARTICIPANTHANDLES
             WHERE j.Z_2REMOTEPARTICIPANTCALLS = ?`
        );
        log.debug({ path, calls: calls.length }, "FaceTime calls near the meeting");

        return calls.map((call) => ({
            pk: call.pk,
            startSec: call.date + CORE_DATA_EPOCH_SEC,
            durationSec: call.duration,
            name: call.name,
            handles: handles.all(call.pk).flatMap((row) => (row.value ? [row.value] : [])),
        }));
    } finally {
        db.close();
    }
}

/** The call that overlaps the meeting the most, else the one that starts closest to it. */
function pickCall<T extends CallRow>(calls: T[], target: AttendanceTarget): T | undefined {
    const startSec = Date.parse(target.start) / 1000;
    const endSec = target.end ? Date.parse(target.end) / 1000 : startSec;
    const overlap = (call: CallRow) =>
        Math.max(0, Math.min(endSec, call.startSec + call.durationSec) - Math.max(startSec, call.startSec));
    return [...calls].sort(
        (a, b) => overlap(b) - overlap(a) || Math.abs(a.startSec - startSec) - Math.abs(b.startSec - startSec)
    )[0];
}

/**
 * FaceTime: CallHistory keeps each call's start, length and remote handles (a phone number or an email), but no
 * join or leave per person and no speaking indicator. So everyone is present for the whole call, the user included.
 * A handle becomes a name through Contacts (GenesisTools.app's Contacts grant), else the call's own name, else itself.
 */
export const faceTimePlatform: MeetingPlatform = {
    id: "facetime",
    label: "FaceTime",
    capabilities: { attendance: "whole-call", speaking: false },
    sourceNames: ["facetime"],

    async attendance(target): Promise<PlatformAttendance | null> {
        const startSec = Date.parse(target.start) / 1000;
        const call = pickCall(readCalls(startSec), target);

        if (!call) {
            return null;
        }

        const contacts = new MacContactsDatabase();
        const names = (() => {
            try {
                return contacts.resolveAll(call.handles);
            } catch (err) {
                log.warn({ err }, "Contacts lookup failed; FaceTime handles stay as they are");
                return new Map<string, string>();
            } finally {
                contacts.close();
            }
        })();
        const stay = { fromSec: call.startSec - startSec, toSec: call.startSec + call.durationSec - startSec };
        const remote: Presence[] = call.handles.map((handle) => ({
            name: names.get(handle) ?? (call.handles.length === 1 && call.name ? call.name : handle),
            ...stay,
        }));

        return {
            presence: [{ name: "self", self: true, ...stay }, ...remote],
            note: `attendance: ${remote.length} people for the whole FaceTime call (call history)`,
        };
    },
};
