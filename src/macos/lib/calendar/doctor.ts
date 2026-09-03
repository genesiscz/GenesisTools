import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import type { CalendarInfo, SourceInfo } from "@genesiscz/darwinkit";
import { ensureBinary } from "@genesiscz/darwinkit";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import {
    type CalendarAuthorizedResult,
    describeCalendarHostApp,
    isPlaceholderCalendarList,
    MacCalendar,
} from "@genesiscz/utils/macos/apple-calendar";

const TCC_DB_PATH = join(homedir(), "Library/Application Support/com.apple.TCC/TCC.db");
const TCC_CALENDAR_SERVICE = "kTCCServiceCalendar";
const CALENDAR_USAGE_KEY = "NSCalendarsFullAccessUsageDescription";

export interface TccCalendarRow {
    client: string;
    /** 0 = bundle id, 1 = absolute path of the executable */
    clientType: number;
    authValue: number;
    label: string;
    lastModified: string;
}

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
        bundleId?: string;
        termProgram?: string;
    };
    tcc: {
        readable: boolean;
        rows: TccCalendarRow[];
        error?: string;
    };
    verdict: string;
    fix?: string;
}

/** TCC `auth_value` meanings for kTCCServiceCalendar on macOS 14+. */
export function tccAuthLabel(authValue: number): string {
    switch (authValue) {
        case 0:
            return "denied";
        case 1:
            return "unknown";
        case 2:
            return "Full Access";
        case 3:
            return "limited";
        case 4:
            return "Add Only";
        default:
            return `unknown (${authValue})`;
    }
}

export function buildVerdict(input: {
    status: string;
    calendarCount: number;
    placeholderOnly: boolean;
    promptSkipped?: boolean;
}): Pick<CalendarDoctorReport, "verdict" | "fix"> {
    const host = describeCalendarHostApp();
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

export function readTccCalendarRows(dbPath = TCC_DB_PATH): CalendarDoctorReport["tcc"] {
    let db: Database | undefined;

    try {
        db = new Database(dbPath, { readonly: true });
        const raw = db
            .query<{ client: string; client_type: number; auth_value: number; last_modified: number }, [string]>(
                "SELECT client, client_type, auth_value, last_modified FROM access WHERE service = ? ORDER BY client"
            )
            .all(TCC_CALENDAR_SERVICE);
        logger.debug({ dbPath, rows: raw.length }, "read TCC calendar rows");

        return {
            readable: true,
            rows: raw.map((r) => ({
                client: r.client,
                clientType: r.client_type,
                authValue: r.auth_value,
                label: tccAuthLabel(r.auth_value),
                lastModified: new Date(r.last_modified * 1000).toISOString(),
            })),
        };
    } catch (error) {
        logger.debug({ error, dbPath }, "TCC.db not readable (needs Full Disk Access)");
        return { readable: false, rows: [], error: error instanceof Error ? error.message : String(error) };
    } finally {
        db?.close();
    }
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
        hostApp,
        tcc,
        ...buildVerdict({
            status: auth.status,
            calendarCount: calendars.length,
            placeholderOnly,
            promptSkipped: !mayRead,
        }),
    };
}
