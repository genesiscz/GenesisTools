/**
 * Read-only permission diagnostics for `tools control`: `doctor` (the three grants, each with
 * the identity that holds it) and `audit` (which running apps carry the accessibility flags an
 * assistive client can set, plus every binary a capability routes through).
 *
 * Nothing in this file mutates. In particular nothing here resolves an app through ax-tool's
 * `resolveApp`, which writes `AXManualAccessibility` into the target; the audit iterates
 * NSWorkspace inside `ax-tool audit` instead. No probe here can show a macOS permission
 * dialog either: `AXIsProcessTrusted` and `CGPreflightScreenCaptureAccess` never prompt, and
 * Automation is read from TCC.db only, because the only live Automation probe is sending an
 * Apple event, which prompts.
 */

import {
    isTccGranted,
    readTccRows,
    TCC_SYSTEM_DB_PATH,
    TCC_USER_DB_PATH,
    type TccRow,
} from "@app/macos/lib/permissions/tcc";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import {
    GENESIS_APP_BUNDLE_ID,
    installedGenesisAppLauncher,
    wrapWithGenesisApp,
} from "@genesiscz/utils/macos/genesis-app";
import { runAx } from "./runner";

export type GrantStatus = "granted" | "denied" | "not-determined" | "unknown";

export interface GrantTarget {
    target: string;
    granted: boolean;
    label: string;
}

export interface PermissionCheck {
    id: "accessibility" | "screen-recording" | "automation";
    label: string;
    status: GrantStatus;
    /** The identity macOS consults, which is the one to tick in System Settings. */
    identity: string;
    pane: string;
    openCommand: string;
    /** How the status was established. */
    source: string;
    detail: string;
    usedBy: string;
    /** Automation is granted per (client, target) pair. */
    targets?: GrantTarget[];
}

export interface CapabilityRoute {
    capability: string;
    commands: string;
    binary: string;
    /** Whose grants the binary uses when `tools control` spawns it. */
    identity: string;
    grant: string;
    note: string;
}

export interface ResponsibleRoute {
    /** The launcher `tools control` prepends to every native spawn, or null when none is usable. */
    launcher: string | null;
    routed: boolean;
    identity: string;
    bundleId?: string;
    reason?: string;
}

/** `ax-tool permissions`: the live grant state of the process `tools control` actually spawns. */
export interface AxLivePermissions {
    accessibility: boolean;
    screenRecording: boolean;
    viaGenesisApp: boolean;
    responsiblePid: number;
    responsibleBundleId: string;
    responsiblePath: string;
}

export interface ControlDoctorReport {
    responsible: ResponsibleRoute;
    live: AxLivePermissions | null;
    liveError?: string;
    checks: PermissionCheck[];
    routes: CapabilityRoute[];
    /** Missing grants and broken routing; a non-empty list is the exit-1 condition. */
    problems: string[];
    /** Worth knowing, not a failure: state that some other client left behind. */
    findings: string[];
}

export interface AuditedApp {
    pid: number;
    name: string;
    bundleId: string;
    policy: string;
    manualAccessibility: string;
    enhancedUserInterface: string;
}

export interface PeekabooGrant {
    name: string;
    granted: boolean;
}

export interface PeekabooAudit {
    installed: boolean;
    path?: string;
    /** `peekaboo permissions status --no-remote`, run the way `tools control` spawns it. */
    local?: PeekabooGrant[];
    localError?: string;
    /** TCC rows for Peekaboo's own identities: the bridge app and the CLI. */
    ownTcc: TccRow[];
}

export interface ControlAuditReport {
    responsible: ResponsibleRoute;
    live: AxLivePermissions | null;
    liveError?: string;
    trusted: boolean;
    checks: PermissionCheck[];
    routes: CapabilityRoute[];
    apps: AuditedApp[];
    appsError?: string;
    manualAccessibilityOn: AuditedApp[];
    enhancedUserInterfaceOn: AuditedApp[];
    unsupported: number;
    unreachable: number;
    peekaboo: PeekabooAudit;
    darwinkit: string;
    problems: string[];
    findings: string[];
}

export const DARWINKIT_NOTE =
    "tools control does not use DarwinKit. The Accessibility client is native/ax-tool; a `darwinkit serve` process on this Mac belongs to other tools (calendar, reminders, mail) and holds no grant tools control depends on.";

const PEEKABOO_IDENTITIES = ["boo.peekaboo.mac", "boo.peekaboo.peekaboo"];
const TCC_AX = "kTCCServiceAccessibility";
const TCC_SCREEN = "kTCCServiceScreenCapture";
const TCC_APPLE_EVENTS = "kTCCServiceAppleEvents";

function settingsPane(name: string): string {
    return `System Settings > Privacy & Security > ${name}`;
}

export function responsibleRoute(): ResponsibleRoute {
    const launcher = installedGenesisAppLauncher();

    if (launcher) {
        return {
            launcher,
            routed: true,
            identity: `GenesisTools.app (${GENESIS_APP_BUNDLE_ID})`,
            bundleId: GENESIS_APP_BUNDLE_ID,
        };
    }

    const host = env.device.getHostBundleIdentifier();
    const reason = env.tools.isAppLauncherDisabled()
        ? "GENESIS_TOOLS_NO_APP=1 is set"
        : "GenesisTools.app is not built or the launcher is switched off (`tools macos permissions`)";

    return {
        launcher: null,
        routed: false,
        identity: host ? `the terminal or host app (${host})` : "the process that launched tools (no bundle)",
        bundleId: host,
        reason,
    };
}

export function capabilityRoutes(route: ResponsibleRoute): CapabilityRoute[] {
    const viaLauncher = route.routed ? route.identity : `${route.identity}; not routed: ${route.reason}`;

    return [
        {
            capability: "Accessibility",
            commands: "see, act, list, tree, find, window, dump, get, set, press, type, hotkey, record, preflight",
            binary: "native/ax-tool (Swift, AX API)",
            identity: viaLauncher,
            grant: "Accessibility",
            note: "spawned through the GenesisTools.app launcher on every call (src/control/lib/runner.ts)",
        },
        {
            capability: "Screen Recording, native",
            commands: "screenshot, ocr, see --path, capture (backend native)",
            binary: "native/ax-tool (CGWindowList, ScreenCaptureKit)",
            identity: viaLauncher,
            grant: "Screen Recording",
            note: "same spawn path as Accessibility",
        },
        {
            capability: "Screen Recording, peekaboo local",
            commands: "capture (backend peekaboo, capture.noRemote)",
            binary: "peekaboo (Homebrew) --no-remote",
            identity: viaLauncher,
            grant: "Screen Recording, Accessibility",
            note: "spawned through the launcher (src/control/lib/peekaboo.ts); Peekaboo's own bundle is not involved",
        },
        {
            capability: "Screen Recording, peekaboo bridge",
            commands: "capture (backend peekaboo, default transport)",
            binary: "peekaboo -> Peekaboo.app daemon",
            identity: "Peekaboo.app (boo.peekaboo.mac), its OWN grants",
            grant: "Screen Recording, Accessibility",
            note: "cannot be routed through GenesisTools.app; plans set capture.noRemote to avoid it",
        },
        {
            capability: "Automation",
            commands: "osascript, focus fallback, browser url/title, countdown overlay",
            binary: "/usr/bin/osascript",
            identity: viaLauncher,
            grant: "Automation (per target app)",
            note: "spawned through the launcher (commands/osascript.ts, lib/peekaboo.ts)",
        },
        {
            capability: "DarwinKit",
            commands: "none",
            binary: "not used",
            identity: "none",
            grant: "none",
            note: DARWINKIT_NOTE,
        },
    ];
}

/**
 * When the launcher is out of the picture, the identity that matters is whatever pid the kernel
 * holds responsible for the probe, which the probe reports itself. `__CFBundleIdentifier` is
 * NOT that pid: a shell inside an editor or agent host carries the host's bundle id while the
 * responsible process is some unbundled binary in between.
 */
export function refineRoute(route: ResponsibleRoute, live: AxLivePermissions | null): ResponsibleRoute {
    if (route.routed || !live) {
        return route;
    }

    const who = live.responsibleBundleId || live.responsiblePath || "no bundle";
    return {
        ...route,
        identity: `pid ${live.responsiblePid} (${who}), not GenesisTools.app`,
        bundleId: live.responsibleBundleId || live.responsiblePath || undefined,
    };
}

function isLivePermissions(value: unknown): value is AxLivePermissions {
    return (
        value !== null &&
        typeof value === "object" &&
        typeof (value as { accessibility?: unknown }).accessibility === "boolean" &&
        typeof (value as { screenRecording?: unknown }).screenRecording === "boolean"
    );
}

export function readLivePermissions(): { live: AxLivePermissions | null; error?: string } {
    const result = runAx(["permissions"]);

    if (!result.ok) {
        return { live: null, error: result.error ?? "ax-tool permissions failed" };
    }

    if (!isLivePermissions(result)) {
        return { live: null, error: "ax-tool permissions returned an unexpected envelope" };
    }

    return { live: result };
}

function tccStatus(rows: TccRow[], readable: boolean): GrantStatus {
    if (!readable) {
        return "unknown";
    }

    if (rows.length === 0) {
        return "not-determined";
    }

    return rows.some(isTccGranted) ? "granted" : "denied";
}

/**
 * Builds the three checks from the live probe and the TCC rows. Pure: the arguments carry every
 * observation, so the verdict logic is testable without a Mac that has the grants.
 */
export function buildChecks(input: {
    route: ResponsibleRoute;
    live: AxLivePermissions | null;
    system: { readable: boolean; rows: TccRow[] };
    user: { readable: boolean; rows: TccRow[] };
}): PermissionCheck[] {
    const { route, live } = input;
    const client = route.bundleId;
    const axRows = input.system.rows.filter((r) => r.service === TCC_AX && r.client === client);
    const screenRows = input.system.rows.filter((r) => r.service === TCC_SCREEN && r.client === client);
    const eventRows = input.user.rows.filter((r) => r.service === TCC_APPLE_EVENTS && r.client === client);
    const via = route.routed ? "via the launcher" : "WITHOUT the launcher";

    function liveCheck(
        id: "accessibility" | "screen-recording",
        label: string,
        usedBy: string,
        probe: string,
        liveValue: boolean | undefined,
        rows: TccRow[]
    ): PermissionCheck {
        const recorded = tccStatus(rows, input.system.readable);
        let status: GrantStatus;
        let source: string;
        let detail: string;

        if (liveValue !== undefined) {
            status = liveValue ? "granted" : recorded === "not-determined" ? "not-determined" : "denied";
            source = `live ${probe} in ax-tool ${via}`;
            detail =
                liveValue || recorded !== "granted"
                    ? `live ${liveValue ? "granted" : "not granted"}; TCC.db for ${client ?? "this identity"}: ${recorded}`
                    : `live NOT granted although TCC.db records a grant for ${client}: the probe did not run as that identity`;
        } else {
            status = recorded;
            source = "TCC.db only (system); the live probe failed";
            detail = rows[0]?.label ?? (input.system.readable ? "no row for this identity" : "database not readable");
        }

        return {
            id,
            label,
            status,
            identity: route.identity,
            pane: settingsPane(label),
            openCommand: `tools macos permissions open --pane ${label.toLowerCase().replace(/ /g, "-")}`,
            source,
            detail,
            usedBy,
        };
    }

    const targets: GrantTarget[] = eventRows.map((r) => ({
        target: r.target ?? "(unknown target)",
        granted: isTccGranted(r),
        label: r.label,
    }));
    const automationStatus = tccStatus(eventRows, input.user.readable);
    const allowed = targets.filter((t) => t.granted).length;

    return [
        liveCheck(
            "accessibility",
            "Accessibility",
            "every AX subcommand, hotkey, record",
            "AXIsProcessTrusted()",
            live?.accessibility,
            axRows
        ),
        liveCheck(
            "screen-recording",
            "Screen Recording",
            "screenshot, ocr, see --path, capture",
            "CGPreflightScreenCaptureAccess()",
            live?.screenRecording,
            screenRows
        ),
        {
            id: "automation",
            label: "Automation",
            status: automationStatus,
            identity: route.identity,
            pane: settingsPane("Automation"),
            openCommand: "tools macos permissions open --pane automation",
            source: "TCC.db only (user); a live probe would send an Apple event and prompt",
            detail: input.user.readable
                ? targets.length === 0
                    ? "no target has been asked yet; the first osascript run prompts per target app"
                    : `${allowed} of ${targets.length} target apps allowed; System Events is the one the focus fallback needs`
                : "database not readable (Full Disk Access missing)",
            usedBy: "osascript, focus fallback, browser url/title, countdown overlay",
            targets,
        },
    ];
}

export function collectProblems(input: {
    route: ResponsibleRoute;
    checks: PermissionCheck[];
    live: AxLivePermissions | null;
    liveError?: string;
}): string[] {
    const { route, checks, live, liveError } = input;
    const problems: string[] = [];

    if (!route.routed) {
        problems.push(
            `ax-tool, peekaboo and osascript run unwrapped, so their grants follow ${route.identity} instead of GenesisTools.app (${route.reason}). Fix: unset GENESIS_TOOLS_NO_APP, or \`tools macos permissions build\` / \`tools macos permissions enable\`.`
        );
    } else if (live && !live.viaGenesisApp) {
        problems.push(
            `the launcher is installed but macOS held pid ${live.responsiblePid} (${live.responsibleBundleId || live.responsiblePath}) responsible for the probe, not GenesisTools.app; run \`tools macos permissions\` to check the bundle's signature.`
        );
    }

    if (liveError) {
        problems.push(`the live ax-tool probe failed: ${liveError}`);
    }

    for (const check of checks) {
        if (check.status === "granted") {
            continue;
        }

        const verb = check.status === "not-determined" ? "has never been asked for" : `is ${check.status} for`;
        problems.push(
            `${check.label} ${verb} ${check.identity}. Open ${check.pane} (\`${check.openCommand}\`) and tick GenesisTools.`
        );
    }

    return problems;
}

function readTcc(route: ResponsibleRoute): {
    system: ReturnType<typeof readTccRows>;
    user: ReturnType<typeof readTccRows>;
} {
    const client = route.bundleId;
    const system = readTccRows({ dbPath: TCC_SYSTEM_DB_PATH, services: [TCC_AX, TCC_SCREEN], client });
    const user = readTccRows({ dbPath: TCC_USER_DB_PATH, services: [TCC_APPLE_EVENTS], client });
    return { system, user };
}

export function controlDoctor(): ControlDoctorReport {
    const { live, error } = readLivePermissions();
    const route = refineRoute(responsibleRoute(), live);
    const { system, user } = readTcc(route);
    const checks = buildChecks({ route, live, system, user });
    logger.debug({ routed: route.routed, live, problems: checks.map((c) => `${c.id}:${c.status}`) }, "control doctor");

    return {
        responsible: route,
        live,
        liveError: error,
        checks,
        routes: capabilityRoutes(route),
        problems: collectProblems({ route, checks, live, liveError: error }),
        findings: [],
    };
}

function isAuditedApp(value: unknown): value is AuditedApp {
    return value !== null && typeof value === "object" && typeof (value as { pid?: unknown }).pid === "number";
}

function normalizeApp(raw: AuditedApp): AuditedApp {
    return {
        pid: raw.pid,
        name: raw.name ?? "",
        bundleId: raw.bundleId ?? "",
        policy: raw.policy ?? "",
        manualAccessibility: raw.manualAccessibility ?? "unknown",
        enhancedUserInterface: raw.enhancedUserInterface ?? "unknown",
    };
}

interface PeekabooPermissionsEnvelope {
    data?: { permissions?: Array<{ name?: string; isGranted?: boolean }> };
}

/**
 * Peekaboo's own view of the grants, for the LOCAL runtime spawned exactly the way the capture
 * runner spawns it. `--no-remote` keeps the probe in-process: the default transport would wake
 * the Peekaboo.app bridge daemon, and an audit must not start services.
 */
export function readPeekabooAudit(): PeekabooAudit {
    const ownTcc = [
        ...readTccRows({ dbPath: TCC_SYSTEM_DB_PATH, services: [TCC_AX, TCC_SCREEN] }).rows,
        ...readTccRows({ dbPath: TCC_USER_DB_PATH, services: [TCC_APPLE_EVENTS] }).rows,
    ].filter((r) => PEEKABOO_IDENTITIES.includes(r.client));
    const path = Bun.which("peekaboo");

    if (!path) {
        return { installed: false, ownTcc };
    }

    const command = wrapWithGenesisApp([path, "permissions", "status", "--json", "--no-remote"]);
    const proc = Bun.spawnSync(command, { timeout: 8_000, killSignal: "SIGKILL", stdout: "pipe", stderr: "pipe" });
    const raw = proc.stdout.toString();
    const start = raw.indexOf("{");
    logger.debug({ command, exitCode: proc.exitCode, bytes: raw.length }, "peekaboo permissions probe");

    if (proc.exitCode !== 0 || start < 0) {
        return { installed: true, path, ownTcc, localError: proc.stderr.toString().trim() || `exit ${proc.exitCode}` };
    }

    try {
        const parsed = SafeJSON.parse(raw.slice(start), { strict: true }) as PeekabooPermissionsEnvelope;
        const local = (parsed.data?.permissions ?? [])
            .filter((p) => typeof p.name === "string")
            .map((p) => ({ name: p.name ?? "", granted: p.isGranted === true }));
        return { installed: true, path, ownTcc, local };
    } catch (error) {
        logger.debug({ error }, "peekaboo permissions output was not JSON");
        return { installed: true, path, ownTcc, localError: "output was not JSON" };
    }
}

export function controlAudit(options: { all?: boolean } = {}): ControlAuditReport {
    const doctor = controlDoctor();
    const result = runAx(options.all ? ["audit", "--all"] : ["audit"], 60_000);
    const apps = (Array.isArray(result.apps) ? result.apps : []).filter(isAuditedApp).map(normalizeApp);
    const trusted = result.trusted === true;
    const flagValues = apps.flatMap((a) => [a.manualAccessibility, a.enhancedUserInterface]);
    const peekaboo = readPeekabooAudit();
    const problems = [...doctor.problems];
    const findings = [...doctor.findings];

    if (!result.ok) {
        problems.push(`ax-tool audit failed: ${result.error}`);
    }

    const manualAccessibilityOn = apps.filter((a) => a.manualAccessibility === "on");
    const enhancedUserInterfaceOn = apps.filter((a) => a.enhancedUserInterface === "on");

    if (manualAccessibilityOn.length > 0) {
        findings.push(
            `AXManualAccessibility is on in ${manualAccessibilityOn.map((a) => a.name).join(", ")}: an assistive client asked for the AX tree, which is what every tools control --app call does, and nothing clears it (only a relaunch of the app does).`
        );
    }

    if (enhancedUserInterfaceOn.length > 0) {
        findings.push(
            `AXEnhancedUserInterface is on in ${enhancedUserInterfaceOn.map((a) => a.name).join(", ")}: tools control never sets it (it changes AppKit layout), so a VoiceOver-style client did.`
        );
    }

    if (peekaboo.local?.some((g) => !g.granted)) {
        problems.push(
            `peekaboo's local runtime lacks ${peekaboo.local
                .filter((g) => !g.granted)
                .map((g) => g.name)
                .join(", ")} when spawned the way tools control spawns it.`
        );
    }

    logger.debug({ apps: apps.length, trusted, peekaboo: peekaboo.installed }, "control audit");

    return {
        responsible: doctor.responsible,
        live: doctor.live,
        liveError: doctor.liveError,
        trusted,
        checks: doctor.checks,
        routes: doctor.routes,
        apps,
        appsError: result.ok ? undefined : result.error,
        manualAccessibilityOn,
        enhancedUserInterfaceOn,
        unsupported: flagValues.filter((v) => v === "unsupported").length,
        unreachable: apps.filter((a) => a.manualAccessibility.startsWith("kAXError")).length,
        peekaboo,
        darwinkit: DARWINKIT_NOTE,
        problems,
        findings,
    };
}
