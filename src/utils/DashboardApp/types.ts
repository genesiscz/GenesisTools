/**
 * Shared types for the DashboardApp factory.
 *
 * `DashboardApp` is the runtime object returned by `defineDashboardApp`. The
 * `DashboardAppConfig` is what callers pass in. Every dashboard CLI in the
 * repo is being migrated to consume this contract so port handling, lifecycle
 * verbs, readiness probes, and launchd integration are all done once.
 *
 * See `/Users/Martin/.claude/plans/golden-wandering-pillow.md` for the
 * design context and decisions log.
 */
import type { Command } from "commander";

export type DashboardAppType = "ui" | "server";

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

    /** Spawn instructions for the child process. */
    spawn: {
        cmd: readonly string[];
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

    /** Launchd opt-in. */
    launchd?: {
        available: boolean;
        /** Plist label. Default `com.genesis-tools.<key>`. */
        label?: string;
    };
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
    status(): Promise<StatusResult>;
    attach(opts?: AttachOptions): Promise<void>;
    logs(opts?: { lines?: number }): Promise<void>;
    install(): Promise<void>;
    uninstall(): Promise<void>;
}
