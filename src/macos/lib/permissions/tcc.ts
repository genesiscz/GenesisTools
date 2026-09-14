import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "@genesiscz/utils/logger";

/** Per-user grants: Calendar, Reminders, Contacts, folders, Automation, Speech, Microphone. */
export const TCC_USER_DB_PATH = join(homedir(), "Library/Application Support/com.apple.TCC/TCC.db");
/** System-wide grants: Full Disk Access, Accessibility, Screen Recording. Readable only with Full Disk Access. */
export const TCC_SYSTEM_DB_PATH = "/Library/Application Support/com.apple.TCC/TCC.db";

export interface TccService {
    /** kTCCService… identifier as stored in TCC.db */
    id: string;
    label: string;
    db: "user" | "system";
    /** System Settings pane id for `tools macos permissions open` */
    pane: string;
}

export const TCC_SERVICES: readonly TccService[] = [
    { id: "kTCCServiceCalendar", label: "Calendars", db: "user", pane: "Privacy_Calendars" },
    { id: "kTCCServiceReminders", label: "Reminders", db: "user", pane: "Privacy_Reminders" },
    { id: "kTCCServiceAddressBook", label: "Contacts", db: "user", pane: "Privacy_Contacts" },
    { id: "kTCCServiceAppleEvents", label: "Automation", db: "user", pane: "Privacy_Automation" },
    { id: "kTCCServiceSpeechRecognition", label: "Speech Recognition", db: "user", pane: "Privacy_SpeechRecognition" },
    { id: "kTCCServiceMicrophone", label: "Microphone", db: "user", pane: "Privacy_Microphone" },
    {
        id: "kTCCServiceSystemPolicyDesktopFolder",
        label: "Desktop folder",
        db: "user",
        pane: "Privacy_FilesAndFolders",
    },
    {
        id: "kTCCServiceSystemPolicyDocumentsFolder",
        label: "Documents folder",
        db: "user",
        pane: "Privacy_FilesAndFolders",
    },
    {
        id: "kTCCServiceSystemPolicyDownloadsFolder",
        label: "Downloads folder",
        db: "user",
        pane: "Privacy_FilesAndFolders",
    },
    { id: "kTCCServiceSystemPolicyAllFiles", label: "Full Disk Access", db: "system", pane: "Privacy_AllFiles" },
    { id: "kTCCServiceAccessibility", label: "Accessibility", db: "system", pane: "Privacy_Accessibility" },
    { id: "kTCCServiceScreenCapture", label: "Screen Recording", db: "system", pane: "Privacy_ScreenCapture" },
];

export interface TccRow {
    service: string;
    client: string;
    /** 0 = bundle id, 1 = absolute path of the executable */
    clientType: number;
    authValue: number;
    /** TCC auth_reason; 9 is a prompt that was never answered */
    authReason?: number;
    /** Automation only: the bundle id the client was granted or denied for */
    target?: string;
    label: string;
    lastModified: string;
}

export interface TccReadResult {
    readable: boolean;
    rows: TccRow[];
    error?: string;
}

const TCC_REASON_PROMPT_TIMEOUT = 9;

/** TCC `auth_value` meanings. 4 is "Add Only" for Calendar and "Limited" style grants elsewhere. */
export function tccAuthLabel(service: string, authValue: number, authReason?: number): string {
    switch (authValue) {
        case 0:
            return authReason === TCC_REASON_PROMPT_TIMEOUT ? "prompt timed out (never answered)" : "denied";
        case 1:
            return "unknown";
        case 2:
            return service === "kTCCServiceCalendar" ? "Full Access" : "allowed";
        case 3:
            return "limited";
        case 4:
            return service === "kTCCServiceCalendar" ? "Add Only" : "limited";
        default:
            return `unknown (${authValue})`;
    }
}

export function isTccGranted(row: TccRow): boolean {
    return row.authValue === 2;
}

interface RawRow {
    service: string;
    client: string;
    client_type: number;
    auth_value: number;
    auth_reason: number | null;
    indirect_object_identifier: string | null;
    last_modified: number;
}

export function readTccRows(options: { dbPath: string; services: readonly string[]; client?: string }): TccReadResult {
    let db: Database | undefined;

    try {
        db = new Database(options.dbPath, { readonly: true });
        const placeholders = options.services.map(() => "?").join(", ");
        const clientClause = options.client ? " AND client = ?" : "";
        const params: string[] = [...options.services];

        if (options.client) {
            params.push(options.client);
        }

        const raw = db
            .query<RawRow, string[]>(
                `SELECT service, client, client_type, auth_value, auth_reason, indirect_object_identifier, last_modified FROM access WHERE service IN (${placeholders})${clientClause} ORDER BY service, client, indirect_object_identifier`
            )
            .all(...params);
        logger.debug({ dbPath: options.dbPath, rows: raw.length, client: options.client }, "read TCC rows");

        return {
            readable: true,
            rows: raw.map((r) => ({
                service: r.service,
                client: r.client,
                clientType: r.client_type,
                authValue: r.auth_value,
                authReason: r.auth_reason ?? undefined,
                target: r.indirect_object_identifier ?? undefined,
                label: tccAuthLabel(r.service, r.auth_value, r.auth_reason ?? undefined),
                lastModified: new Date(r.last_modified * 1000).toISOString(),
            })),
        };
    } catch (error) {
        logger.debug({ error, dbPath: options.dbPath }, "TCC.db not readable");
        return { readable: false, rows: [], error: error instanceof Error ? error.message : String(error) };
    } finally {
        db?.close();
    }
}
