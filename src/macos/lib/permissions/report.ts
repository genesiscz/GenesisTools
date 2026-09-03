import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import {
    GENESIS_APP_BUNDLE_ID,
    isGenesisAppDisabledByMarker,
    type ResponsibleIdentity,
    responsibleIdentity,
} from "@genesiscz/utils/macos/genesis-app";
import { type AppStatus, appStatus } from "./app";
import {
    isTccGranted,
    readTccRows,
    TCC_SERVICES,
    TCC_SYSTEM_DB_PATH,
    TCC_USER_DB_PATH,
    type TccReadResult,
    type TccService,
} from "./tcc";

export interface ServiceGrant {
    service: TccService;
    /** undefined when the database was unreadable */
    granted?: boolean;
    label: string;
}

export interface PermissionsReport {
    identity: ResponsibleIdentity;
    /** the launcher marker the current process runs under, if any */
    hostBundleId?: string;
    app: AppStatus;
    /** grants recorded for the GenesisTools.app bundle id */
    grants: ServiceGrant[];
    /** com.genesis-tools.* launchd labels whose plist does not go through the launcher */
    launchdJobsOutsideApp: string[];
    /** the settings window's "Route tools through this app" switch is off */
    disabledByMarker: boolean;
    userDb: Pick<TccReadResult, "readable" | "error">;
    systemDb: Pick<TccReadResult, "readable" | "error">;
    problems: string[];
}

export function grantsFor(
    client: string,
    user: TccReadResult,
    system: TccReadResult,
    services: readonly TccService[] = TCC_SERVICES
): ServiceGrant[] {
    return services.map((service) => {
        const source = service.db === "user" ? user : system;

        if (!source.readable) {
            return { service, label: "unknown (database not readable)" };
        }

        const row = source.rows.find((r) => r.service === service.id && r.client === client);

        if (!row) {
            return { service, granted: false, label: "not asked yet" };
        }

        return { service, granted: isTccGranted(row), label: row.label };
    });
}

const LAUNCH_AGENTS_DIR = join(homedir(), "Library", "LaunchAgents");
const LAUNCHD_LABEL_PREFIX = "com.genesis-tools.";

/**
 * ProgramArguments of one plist, XML or binary alike. `plutil` is the only reader guaranteed to
 * handle both, and reading the array is what makes this agree with the app's own scanner: a
 * substring test over the file would also match the launcher path inside StandardOutPath or an
 * EnvironmentVariables value, and would miss a path the writer had to XML-escape.
 */
export function launchdProgramArguments(plistPath: string): string[] {
    const proc = Bun.spawnSync(["plutil", "-extract", "ProgramArguments", "json", "-o", "-", plistPath], {
        stdout: "pipe",
        stderr: "pipe",
    });

    if (proc.exitCode !== 0) {
        logger.debug({ plistPath, exitCode: proc.exitCode }, "permissions: plist has no readable ProgramArguments");
        return [];
    }

    const parsed = SafeJSON.parse(new TextDecoder().decode(proc.stdout));
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
}

/** A plist written before the app existed (or with GENESIS_TOOLS_NO_APP=1) keeps the bare command forever. */
export function launchdJobsOutsideApp(launcherPath: string, dir = LAUNCH_AGENTS_DIR): string[] {
    if (!existsSync(dir)) {
        return [];
    }

    const labels: string[] = [];

    for (const name of readdirSync(dir)) {
        if (!name.startsWith(LAUNCHD_LABEL_PREFIX) || !name.endsWith(".plist")) {
            continue;
        }

        if (!launchdProgramArguments(join(dir, name)).includes(launcherPath)) {
            labels.push(name.slice(0, -".plist".length));
        }
    }

    return labels.sort();
}

export function collectProblems(report: Omit<PermissionsReport, "problems">): string[] {
    const problems: string[] = [];

    // The per-user TCC.db is itself behind Full Disk Access, so failing to open it while running as
    // GenesisTools.app is a positive probe: FDA is missing, and so are Mail, Messages and Voice Memos.
    if (report.identity.kind === "genesis-app" && report.app.built && !report.userDb.readable) {
        problems.push(
            "Full Disk Access is not granted to GenesisTools: Mail, Messages, Voice Memos and the grant table below are unavailable. Run `tools macos permissions open --pane full-disk-access`; the picker lists GenesisTools under Applications."
        );
    }

    if (!report.app.built) {
        problems.push(
            "GenesisTools.app is not built: permissions follow the terminal. Run `tools macos permissions build`."
        );
    } else if (!report.app.identityStable) {
        problems.push(
            "GenesisTools.app is ad-hoc signed: every rebuild gets a new identity and macOS forgets its grants. Sign with a Developer ID or Apple Development certificate."
        );
    } else if (report.app.stale) {
        problems.push("GenesisTools.app sources changed since the last build. Run `tools macos permissions build`.");
    }

    if (report.app.built && report.launchdJobsOutsideApp.length > 0) {
        problems.push(
            `launchd jobs still run outside GenesisTools.app and keep the terminal-less grants: ${report.launchdJobsOutsideApp.join(", ")}. Each migrates on its next start: \`tools <dashboard> ui up\`, \`tools ai-proxy daemon install\`, \`tools daemon restart\`, \`tools automate daemon install\`.`
        );
    }

    if (report.app.built && report.disabledByMarker) {
        problems.push(
            "The launcher is switched off (GenesisTools window > Settings, or `tools macos permissions disable`): tools run under the terminal's grants. Re-enable with `tools macos permissions enable`."
        );
    } else if (report.app.built && report.identity.kind !== "genesis-app") {
        problems.push(
            "This process is not running under GenesisTools.app (GENESIS_TOOLS_NO_APP set, or started outside `tools`)."
        );
    }

    return problems;
}

export function permissionsReport(): PermissionsReport {
    const services = TCC_SERVICES.map((s) => s.id);
    const user = readTccRows({ dbPath: TCC_USER_DB_PATH, services, client: GENESIS_APP_BUNDLE_ID });
    const system = readTccRows({ dbPath: TCC_SYSTEM_DB_PATH, services, client: GENESIS_APP_BUNDLE_ID });
    const app = appStatus();
    const partial = {
        identity: responsibleIdentity(),
        hostBundleId: env.device.getHostBundleIdentifier(),
        app,
        grants: grantsFor(GENESIS_APP_BUNDLE_ID, user, system),
        launchdJobsOutsideApp: app.built ? launchdJobsOutsideApp(app.launcherPath) : [],
        disabledByMarker: isGenesisAppDisabledByMarker(),
        userDb: { readable: user.readable, error: user.error },
        systemDb: { readable: system.readable, error: system.error },
    };

    return { ...partial, problems: collectProblems(partial) };
}

export const SETTINGS_PANES: Record<string, string> = Object.fromEntries(
    TCC_SERVICES.map((s) => [s.label.toLowerCase().replace(/ /g, "-"), s.pane])
);

export function settingsUrl(pane: string): string {
    return `x-apple.systempreferences:com.apple.preference.security?${pane}`;
}
