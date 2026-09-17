/**
 * Shared types for the DashboardApp factory.
 *
 * `DashboardApp` is the runtime object returned by `defineDashboardApp`. The
 * `DashboardAppConfig` is what callers pass in. Every dashboard CLI in the
 * repo is being migrated to consume this contract so port handling, lifecycle
 * verbs, readiness probes, and launchd integration are all done once.
 *
 * See the DashboardApp design notes in the repo docs for design context.
 */
import type { Command } from "commander";

export type DashboardAppType = "ui" | "server";

/** Vite / dev-server bind address. Default `127.0.0.1` (localhost only). */
export type DashboardBindHost = "127.0.0.1" | "0.0.0.0";

export type ReadinessProbe =
    | { kind: "http"; path?: string; timeoutMs?: number }
    | { kind: "log"; regex: RegExp; timeoutMs?: number }
    | { kind: "port"; timeoutMs?: number };

export type DependencyPolicy =
    /** Silently start the dep before us. */
    | "auto"
    /** Prompt the user (TTY); on non-TTY, warn and proceed without starting. */
    | "prompt"
    /** Print a warning if the dep is down; never auto-start. */
    | "warn";

export interface DashboardDependency {
    /** Late-bound to avoid circular factory references. */
    app: DashboardApp;
    policy: DependencyPolicy;
}

export interface PreflightWarning {
    service: string;
    error: string;
    fix?: string;
}

export type DashboardQrOption = boolean | { small?: boolean; level?: "L" | "M" | "Q" | "H" };

export interface DashboardAccessConfig {
    /** Print a LAN QR code under the URL banner. Default off. */
    qr?: DashboardQrOption;
    /** Banner label prefix. Default "dashboard". */
    label?: string;
    /** Resolve the URL shown in the banner (and encoded in the QR). */
    url?: (port: number) => string;
}

export interface DashboardAppConfig {
    type: DashboardAppType;

    /** Stable id. Used for PID/log paths and (for type:"ui") to look up port from DASHBOARDS registry. */
    key: string;

    /** Display name for status output. Defaults to `key`. */
    name?: string;

    /** Description shown in --help. */
    description: string;

    /** CLI subcommand name (e.g. "ui", "dashboard", "server"). */
    commandName: string;

    /** Optional CLI aliases for the subcommand. */
    aliases?: string[];

    /** Port. For type:"ui" defaults to DASHBOARDS[key].port; for type:"server" required. */
    port?: number;

    /**
     * Listen address, UI and server dashboards alike; the child reads it from `DASHBOARD_BIND_HOST`.
     * Default `127.0.0.1`. `0.0.0.0` only when the dashboard must be reachable on the LAN or through
     * a tunnel (dev-dashboard + cloudflared). The user overrides either value per machine with
     * `bindHost` in `~/.genesis-tools/dashboards/<key>.config.json`.
     */
    bindHost?: DashboardBindHost;

    /** Spawn instructions for the child process. */
    spawn: {
        cmd: readonly string[];
        /** When set, `up --dev`, `restart --dev` and the `dev` verb use this instead of `cmd` (vite dev + HMR). */
        devCmd?: readonly string[];
        /**
         * When set, `install --preview` registers this instead of `cmd`: the watch build that rebuilds
         * on save and reloads the page, the mode a tunnel-served dashboard ran before `cmd` became
         * a one-off build. Remembered per dashboard, so a later `up` keeps it.
         */
        previewCmd?: readonly string[];
        cwd?: string;
        env?: Record<string, string | undefined>;
    };

    /** Optional preflight checks. Soft warnings; surfaced in `status` and on `up`. */
    preflight?: () => Promise<{ warnings: PreflightWarning[] }>;

    /** Other DashboardApps this one needs. */
    dependencies?: DashboardDependency[];

    /** How to know the process is ready before browser-open / dependency wait completes. */
    readiness?: ReadinessProbe;

    /** Browser-open policy (effective only for type:"ui"). */
    openBrowser?: {
        enabled: boolean;
        url?: (port: number) => string;
    };

    /** Optional LAN URL banner + QR when presenting or opening the dashboard. */
    access?: DashboardAccessConfig;

    /** Options for the shared `open` verb (preflight, non-TTY serve hint). */
    open?: DashboardOpenConfig;

    /** Launchd opt-in. */
    launchd?: {
        available: boolean;
        /** Plist label. Default `com.genesis-tools.<key>`. */
        label?: string;
    };
}

export interface DashboardOpenConfig {
    preflight?: () => Promise<void>;
    serveHint?: { tool: string; replaceCommand: string[] };
}

export interface OpenOptions {
    port?: number;
    query?: Record<string, string>;
    openBrowser?: boolean;
    /** When false, skip QR even if access.qr is set. */
    qr?: boolean;
}

export interface UpOptions {
    foreground?: boolean;
    port?: number;
    force?: boolean;
    open?: boolean;
    /** Suppress the launchd first-run prompt for this invocation. */
    skipInstallPrompt?: boolean;
    /** When true, forces the interactive menu even on unambiguous actions. */
    interactive?: boolean;
    /** When true, an already-running instance on our port is stopped without a menu (used by `install`). */
    replaceRunning?: boolean;
    /** `dev`: `spawn.devCmd` (`up --dev`). `preview`: `spawn.previewCmd` (what `install --preview` registers). */
    uiServe?: "dev" | "preview";
}

export interface InstallOptions {
    force?: boolean;
    port?: number;
    /** Register `spawn.previewCmd` (watch build) instead of `spawn.cmd`; remembered for later `up`s. */
    preview?: boolean;
}

export interface UpResult {
    started: boolean;
    pid?: number;
    port: number;
    /** "foreground" blocks; "background" returns immediately after readiness. */
    mode: "foreground" | "background";
    logPath?: string;
}

export interface DownOptions {
    /** Escalate to SIGKILL after grace period (default true). */
    force?: boolean;
}

export interface DownResult {
    stopped: boolean;
    pid?: number;
}

export interface DependencyStatus {
    key: string;
    running: boolean;
    pid?: number;
    port: number;
}

export interface StatusResult {
    key: string;
    type: DashboardAppType;
    running: boolean;
    pid?: number;
    port: number;
    /** Uptime in milliseconds (only set when running and we know start time). */
    uptimeMs?: number;
    logPath: string;
    launchdAvailable: boolean;
    launchdInstalled: boolean;
    dependencies: DependencyStatus[];
    preflightWarnings: PreflightWarning[];
}

export interface AttachOptions {
    /** Tail last N lines on attach (default 50). */
    lines?: number;
}

export interface DashboardApp {
    /** The config the app was created with (frozen). */
    readonly config: DashboardAppConfig;
    /** Resolved port (from config.port or DASHBOARDS[key].port). */
    readonly port: number;
    /** Where the PID file lives. */
    readonly pidFile: string;
    /** Where the background log file lives. */
    readonly logFile: string;

    /** Plug into the parent commander: `parent.addCommand(app.commanderCommand)`. */
    readonly commanderCommand: Command;

    up(opts?: UpOptions): Promise<UpResult>;
    down(opts?: DownOptions): Promise<DownResult>;
    restart(opts?: UpOptions): Promise<UpResult>;
    /** Foreground dev server in place of the installed one, which comes back when it exits (needs `spawn.devCmd`). */
    dev(opts?: UpOptions): Promise<never>;
    status(): Promise<StatusResult>;
    attach(opts?: AttachOptions): Promise<void>;
    logs(opts?: { lines?: number }): Promise<void>;
    install(opts?: InstallOptions): Promise<void>;
    uninstall(): Promise<void>;
    open(opts?: OpenOptions): Promise<void>;
}
