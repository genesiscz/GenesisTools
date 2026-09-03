import { existsSync } from "node:fs";
import { join } from "node:path";
import { execPath } from "node:process";
import type { CalendarInfo, SourceInfo } from "@genesiscz/darwinkit";
import { ensureBinary } from "@genesiscz/darwinkit";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import {
    type CalendarAuthorizedResult,
    isPlaceholderCalendarList,
    MacCalendar,
} from "@genesiscz/utils/macos/apple-calendar";
import {
    describeResponsibleIdentity,
    type ResponsibleIdentity,
    responsibleIdentity,
} from "@genesiscz/utils/macos/genesis-app";
import { readTccRows, TCC_USER_DB_PATH, type TccReadResult, type TccRow } from "../permissions/tcc";

const TCC_CALENDAR_SERVICE = "kTCCServiceCalendar";
const CALENDAR_USAGE_KEY = "NSCalendarsFullAccessUsageDescription";

export interface CalendarDoctorReport {
    status: string;
    /** True when the status was NOT read, because reading it would have prompted. */
    promptSkipped: boolean;
    authorized: boolean;
    calendarCount: number;
    placeholderOnly: boolean;
    sources: Pick<SourceInfo, "title" | "source_type">[];
    binary: {
        path: string;
        inAppBundle: boolean;
        /** null when the binary has no Info.plist at all */
        hasCalendarUsageString: boolean | null;
    };
    hostApp: {
        /** who macOS holds responsible for this process */
        responsible: ResponsibleIdentity;
        bundleId?: string;
        termProgram?: string;
    };
    tcc: TccReadResult;
    verdict: string;
    fix?: string;
}

export type TccCalendarRow = TccRow;

export function buildVerdict(input: {
    status: string;
    calendarCount: number;
    placeholderOnly: boolean;
    promptSkipped?: boolean;
}): Pick<CalendarDoctorReport, "verdict" | "fix"> {
    const host = describeResponsibleIdentity();
    const fix = `System Settings > Privacy & Security > Calendars: set ${host} to Full Access, then re-run.`;

    if (input.promptSkipped) {
        return {
            verdict:
                "macOS has recorded no Calendar answer for this process, and the doctor did not ask: reading the status would show the permission dialog and write a durable TCC grant, which a diagnostic must never do.",
            fix: `Run \`tools macos calendar list-calendars\` once and answer the macOS dialog, or grant it yourself: ${fix}`,
        };
    }

    switch (input.status) {
        case "fullAccess":
            if (input.calendarCount === 0) {
                return {
                    verdict: "Full Access is granted and the store holds no calendars: the calendar really is empty.",
                };
            }

            return { verdict: `Full Access is granted; ${input.calendarCount} calendars visible.` };
        case "writeOnly":
            return {
                verdict: `Access is Add Only: EventKit hides every real calendar and event${input.placeholderOnly ? " and returns one placeholder calendar" : ""}. An empty list from this process is NOT an empty calendar.`,
                fix,
            };
        case "denied":
            return { verdict: "Access is denied: this process may not read the calendar.", fix };
        case "restricted":
            return { verdict: "Access is restricted by a profile or parental controls.", fix };
        default:
            return {
                verdict: `Status is ${input.status}: macOS has not asked yet and showed no prompt for this process.`,
                fix,
            };
    }
}

function appBundleInfoPlist(binaryPath: string): string | undefined {
    const marker = ".app/Contents/MacOS/";
    const idx = binaryPath.indexOf(marker);

    if (idx === -1) {
        return undefined;
    }

    return join(binaryPath.slice(0, idx + ".app/Contents/".length), "Info.plist");
}

function plistHasKey(plistPath: string, key: string): boolean {
    const proc = Bun.spawnSync(["plutil", "-extract", key, "raw", "-o", "-", plistPath]);
    logger.debug({ plistPath, key, exitCode: proc.exitCode }, "plutil key probe");
    return proc.exitCode === 0;
}

export function readTccCalendarRows(dbPath = TCC_USER_DB_PATH): TccReadResult {
    return readTccRows({ dbPath, services: [TCC_CALENDAR_SERVICE] });
}

/**
 * True when macOS has already recorded an answer for this process, so reading
 * the status cannot show a dialog.
 *
 * `MacCalendar.authorizationStatus()` REQUESTS access when the status is still
 * notDetermined (darwinkit 0.7.5 has no non-prompting status call), and a TCC
 * grant is durable state every later process observes. TCC.db carries the
 * recorded answer, keyed by bundle id (`client_type` 0) or by the launching
 * executable's absolute path (`client_type` 1).
 */
export function tccDecisionRecorded(
    tcc: CalendarDoctorReport["tcc"],
    hostApp: { bundleId?: string; executablePath?: string }
): boolean {
    if (!tcc.readable) {
        // Cannot prove a decision exists, so assume none: the doctor must not
        // gamble a permission dialog on a guess.
        return false;
    }

    return tcc.rows.some(
        (row) =>
            (row.clientType === 0 && row.client === hostApp.bundleId) ||
            (row.clientType === 1 && row.client === hostApp.executablePath)
    );
}

export interface CalendarDoctorOptions {
    /**
     * Read the status even when that may show the macOS permission dialog and
     * write a TCC grant. Off by default: `doctor` is a diagnostic.
     */
    requestAccess?: boolean;
}

export async function runCalendarDoctor(opts: CalendarDoctorOptions = {}): Promise<CalendarDoctorReport> {
    const binaryPath = await ensureBinary();
    const plistPath = appBundleInfoPlist(binaryPath);
    const hasCalendarUsageString =
        plistPath && existsSync(plistPath) ? plistHasKey(plistPath, CALENDAR_USAGE_KEY) : null;

    const hostApp = { bundleId: env.device.getHostBundleIdentifier(), termProgram: env.device.getTermProgram() };
    const tcc = readTccCalendarRows();
    const mayRead = opts.requestAccess === true || tccDecisionRecorded(tcc, { ...hostApp, executablePath: execPath });
    const auth: CalendarAuthorizedResult = mayRead
        ? await MacCalendar.authorizationStatus()
        : { status: "notDetermined", authorized: false };

    if (!mayRead) {
        logger.debug({ bundleId: hostApp.bundleId, tccReadable: tcc.readable }, "calendar doctor: skipped the prompt");
    }

    let calendars: CalendarInfo[] = [];
    let sources: SourceInfo[] = [];

    if (auth.status === "fullAccess" || auth.status === "writeOnly") {
        [calendars, sources] = await Promise.all([MacCalendar.listCalendarsUnguarded(), MacCalendar.getSources()]);
    }

    const placeholderOnly = isPlaceholderCalendarList(calendars);

    return {
        status: auth.status,
        promptSkipped: !mayRead,
        authorized: auth.authorized,
        calendarCount: calendars.length,
        placeholderOnly,
        sources: sources.map((s) => ({ title: s.title, source_type: s.source_type })),
        binary: { path: binaryPath, inAppBundle: plistPath !== undefined, hasCalendarUsageString },
        // `hostApp` is also the input to tccDecisionRecorded above, so it stays a const;
        // `responsible` is who macOS actually asks, which is the app when the launcher ran us.
        hostApp: { responsible: responsibleIdentity(), ...hostApp },
        tcc,
        ...buildVerdict({
            status: auth.status,
            calendarCount: calendars.length,
            placeholderOnly,
            promptSkipped: !mayRead,
        }),
    };
}
