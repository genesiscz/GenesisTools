import { existsSync } from "node:fs";
import { execPath } from "node:process";
import { ensureBinary } from "@genesiscz/darwinkit";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import { MacReminders, type RemindersAuthResult } from "@genesiscz/utils/macos/apple-reminders";
import {
    describeResponsibleIdentity,
    type ResponsibleIdentity,
    responsibleIdentity,
} from "@genesiscz/utils/macos/genesis-app";
// Generic (not calendar-specific): a recorded TCC answer for any service means reading the
// status cannot show a dialog. Shared from Calendar's doctor instead of duplicated.
import { readTccRows, TCC_USER_DB_PATH, type TccReadResult, type TccRow } from "../permissions/tcc";

const TCC_REMINDERS_SERVICE = "kTCCServiceReminders";
const REMINDERS_USAGE_KEY = "NSRemindersFullAccessUsageDescription";

export interface RemindersDoctorReport {
    status: string;
    /** True when the status was NOT read, because reading it would have prompted. */
    promptSkipped: boolean;
    authorized: boolean;
    listCount: number;
    binary: {
        path: string;
        inAppBundle: boolean;
        /** null when the binary has no Info.plist at all */
        hasRemindersUsageString: boolean | null;
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

export type TccRemindersRow = TccRow;

export function buildRemindersVerdict(input: {
    status: string;
    listCount: number;
    promptSkipped?: boolean;
}): Pick<RemindersDoctorReport, "verdict" | "fix"> {
    const host = describeResponsibleIdentity();
    const fix = `System Settings > Privacy & Security > Reminders, set ${host} on, then re-run.`;

    if (input.promptSkipped) {
        return {
            verdict:
                "macOS has recorded no Reminders answer for this process, and the doctor did not ask: reading the status would show the permission dialog and write a durable TCC grant, which a diagnostic must never do.",
            fix: `Run \`tools macos reminders list-lists\` once and answer the macOS dialog, or grant it yourself: ${fix}`,
        };
    }

    switch (input.status) {
        case "fullAccess":
            if (input.listCount === 0) {
                return {
                    verdict: "Access is granted and the store holds no reminder lists: Reminders really is empty.",
                };
            }

            return { verdict: `Access is granted; ${input.listCount} reminder lists visible.` };
        case "denied":
            return { verdict: "Access is denied: this process may not read Reminders.", fix };
        case "restricted":
            return { verdict: "Access is restricted by a profile or parental controls.", fix };
        case "notDetermined":
            return {
                verdict: `macOS has not asked ${host} for Reminders access yet, so there is no switch to turn on in System Settings.`,
                fix: "Run `tools macos reminders doctor --request-access` (or `tools macos reminders list-lists`) and answer the macOS dialog.",
            };
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

    return `${binaryPath.slice(0, idx + ".app/Contents/".length)}Info.plist`;
}

function plistHasKey(plistPath: string, key: string): boolean {
    const proc = Bun.spawnSync(["plutil", "-extract", key, "raw", "-o", "-", plistPath]);
    logger.debug({ plistPath, key, exitCode: proc.exitCode }, "plutil key probe");
    return proc.exitCode === 0;
}

export function readTccRemindersRows(dbPath = TCC_USER_DB_PATH): TccReadResult {
    return readTccRows({ dbPath, services: [TCC_REMINDERS_SERVICE] });
}

export interface RemindersDoctorOptions {
    /**
     * Ask macOS for Reminders access when the status is still notDetermined, which shows the
     * permission dialog and writes a TCC grant. Off by default: `doctor` is a diagnostic.
     */
    requestAccess?: boolean;
}

/** What the doctor reaches outside the process, injectable so a test never touches Reminders. */
export interface RemindersDoctorDeps {
    binaryPath: () => Promise<string>;
    readTcc: () => TccReadResult;
    /** Must never prompt. */
    authorizationStatus: () => Promise<RemindersAuthResult>;
    requestAccess: () => Promise<RemindersAuthResult>;
    listCount: () => Promise<number>;
}

const defaultDoctorDeps: RemindersDoctorDeps = {
    binaryPath: () => ensureBinary(),
    readTcc: () => readTccRemindersRows(),
    authorizationStatus: () => MacReminders.authorizationStatus(),
    requestAccess: () => MacReminders.requestAccess(),
    listCount: async () => (await MacReminders.listListsUnguarded()).length,
};

/**
 * Unlike Calendar's, the Reminders status read never prompts (`reminders.authorization_status`),
 * so the doctor always reads it, whether or not TCC.db is readable. Only `requestAccess` asks.
 */
export async function runRemindersDoctor(
    opts: RemindersDoctorOptions = {},
    deps: RemindersDoctorDeps = defaultDoctorDeps
): Promise<RemindersDoctorReport> {
    const binaryPath = await deps.binaryPath();
    const plistPath = appBundleInfoPlist(binaryPath);
    const hasRemindersUsageString =
        plistPath && existsSync(plistPath) ? plistHasKey(plistPath, REMINDERS_USAGE_KEY) : null;

    const hostApp = { bundleId: env.device.getHostBundleIdentifier(), termProgram: env.device.getTermProgram() };
    const tcc = deps.readTcc();
    let auth = await deps.authorizationStatus();

    if (opts.requestAccess === true && auth.status === "notDetermined") {
        logger.debug({ tccReadable: tcc.readable }, "reminders doctor: asking macOS for access (--request-access)");
        auth = await deps.requestAccess();
    }

    const listCount = auth.authorized ? await deps.listCount() : 0;

    return {
        status: auth.status,
        promptSkipped: false,
        authorized: auth.authorized,
        listCount,
        binary: { path: binaryPath, inAppBundle: plistPath !== undefined, hasRemindersUsageString },
        hostApp: { responsible: responsibleIdentity(), ...hostApp, executablePath: execPath },
        tcc,
        ...buildRemindersVerdict({ status: auth.status, listCount, promptSkipped: false }),
    };
}
