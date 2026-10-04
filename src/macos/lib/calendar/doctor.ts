import { existsSync } from "node:fs";
import { join } from "node:path";
import { execPath } from "node:process";
import type { CalendarInfo, SourceInfo } from "@genesiscz/darwinkit";
import { ensureBinary } from "@genesiscz/darwinkit";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
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
        /** the executable a path-keyed TCC row (client_type 1) names for this process */
        executablePath: string;
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
            fix: `Run \`${toolCommand("macos calendar list-calendars")}\` once and answer the macOS dialog, or grant it yourself: ${fix}`,
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

/** The two keys TCC.db can name this process by. */
export interface TccClient {
    bundleId?: string;
    executablePath?: string;
}

/**
 * Who TCC.db names this process by: the responsible bundle id (GenesisTools.app when the launcher
 * ran us; `__CFBundleIdentifier` still names the terminal then, so it is never the key) and the
 * executable path.
 */
export function thisProcessTccClient(): TccClient {
    return { bundleId: responsibleIdentity().bundleId, executablePath: execPath };
}

/**
 * Whether a TCC row is this process's own: a bundle-id row (client_type 0) by the bundle id, a
 * path row (client_type 1) by the executable path.
 */
export function isThisProcessRow(row: TccRow, client: TccClient): boolean {
    if (row.clientType === 0) {
        return client.bundleId !== undefined && row.client === client.bundleId;
    }

    return row.clientType === 1 && client.executablePath !== undefined && row.client === client.executablePath;
}

/** One TCC row for a doctor's listing, marked when it is this process's own. */
export function tccRowLine(row: TccRow, client: TccClient): string {
    return `${row.client}: ${row.label}${isThisProcessRow(row, client) ? "  <- this process" : ""}`;
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
export function tccDecisionRecorded(tcc: CalendarDoctorReport["tcc"], client: TccClient): boolean {
    if (!tcc.readable) {
        // Cannot prove a decision exists, so assume none: the doctor must not
        // gamble a permission dialog on a guess.
        return false;
    }

    return tcc.rows.some((row) => isThisProcessRow(row, client));
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
    const client = thisProcessTccClient();
    const mayRead = opts.requestAccess === true || tccDecisionRecorded(tcc, client);
    const auth: CalendarAuthorizedResult = mayRead
        ? await MacCalendar.authorizationStatus()
        : { status: "notDetermined", authorized: false };

    if (!mayRead) {
        logger.debug({ client, tccReadable: tcc.readable }, "calendar doctor: skipped the prompt");
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
        // `responsible` is who macOS actually asks, which is the app when the launcher ran us.
        hostApp: { responsible: responsibleIdentity(), ...hostApp, executablePath: execPath },
        tcc,
        ...buildVerdict({
            status: auth.status,
            calendarCount: calendars.length,
            placeholderOnly,
            promptSkipped: !mayRead,
        }),
    };
}
