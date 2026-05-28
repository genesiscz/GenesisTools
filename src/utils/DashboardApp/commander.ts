/**
 * Build the commander subcommand tree for a DashboardApp.
 *
 * Verb hierarchy:
 *
 *   <commandName> [verb]            — verb defaults to a smart "what should I do"
 *     up           --foreground --port <n> --force --no-open
 *     down         --force
 *     restart      (same flags as up)
 *     status
 *     attach       --lines <n>
 *     logs         --lines <n>
 *     open         --port <n> --no-qr --no-open --query key=value
 *     install      (only if launchd.available)
 *     uninstall    (only if launchd.available)
 *
 * Global flag on every verb AND the no-verb default:
 *     -i, --interactive   force the menu
 */
import { Command } from "commander";
import {
    attach,
    down,
    install,
    type LifecycleContext,
    logs,
    openDashboard,
    printStatus,
    restart,
    uninstall,
    up,
} from "./lifecycle";
import type { DashboardAppConfig } from "./types";

interface BuildOptions {
    config: DashboardAppConfig;
    ctx: LifecycleContext;
}

interface UpFlags {
    foreground?: boolean;
    port?: string;
    force?: boolean;
    open?: boolean;
    interactive?: boolean;
    dev?: boolean;
}

function parsePort(value: string): number {
    const parsed = Number.parseInt(value, 10);

    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65_535) {
        throw new Error(`Invalid --port value: ${value}`);
    }

    return parsed;
}

function parseLines(value: string): number {
    const parsed = Number.parseInt(value, 10);

    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Invalid --lines value: ${value}`);
    }

    return parsed;
}

function parseQueryParam(value: string, previous: Record<string, string> = {}): Record<string, string> {
    const eq = value.indexOf("=");

    if (eq <= 0) {
        throw new Error(`Invalid --query value: ${value} (expected key=value)`);
    }

    return { ...previous, [value.slice(0, eq)]: value.slice(eq + 1) };
}

interface OpenFlags {
    port?: string;
    qr?: boolean;
    open?: boolean;
    query?: Record<string, string>;
}

function toUpOptions(flags: UpFlags) {
    return {
        foreground: flags.foreground,
        port: flags.port ? parsePort(flags.port) : undefined,
        force: flags.force,
        open: flags.open,
        interactive: flags.interactive,
        uiServe: flags.dev ? ("dev" as const) : undefined,
    };
}

function applyUpFlags(cmd: Command, config: DashboardAppConfig): void {
    cmd.option("-f, --foreground", "run in the foreground (block until killed)")
        .option("-p, --port <n>", "override the default port")
        .option("--force", "kill any conflicting process before starting")
        .option("--no-open", "do not auto-open the browser (UI apps only)")
        .option("-i, --interactive", "force the menu");

    if (config.spawn.devCmd) {
        cmd.option("--dev", "use Vite dev + HMR instead of watch+preview bundle");
    }
}

export function buildCommanderCommand({ config, ctx }: BuildOptions): Command {
    const cmd = new Command(config.commandName).description(config.description);
    for (const alias of config.aliases ?? []) {
        cmd.alias(alias);
    }

    // Bare command (no verb) — smart default. Options are intentionally NOT
    // duplicated from the `up` subcommand because Commander v14 silently drops
    // options on a subcommand when the same names exist on the parent action.
    // For explicit control use `up --foreground` (etc); the bare command runs
    // with defaults (background, open=true).
    cmd.option("-i, --interactive", "force the interactive menu even when the action is unambiguous").action(
        async (flags: { interactive?: boolean }) => {
            await up(ctx, {
                interactive: flags.interactive,
                open: config.type === "ui" ? (config.openBrowser?.enabled ?? true) : false,
            });
        }
    );

    // `up`
    const upCmd = cmd.command("up").description("Start (default: background). Use --foreground to block.");
    applyUpFlags(upCmd, config);
    upCmd.action(async (flags: UpFlags) => {
        await up(ctx, toUpOptions(flags));
    });

    // `down`
    cmd.command("down")
        .alias("stop")
        .description("Stop the running instance.")
        .option("--no-force", "do NOT escalate to SIGKILL after grace period")
        .action(async (flags: { force?: boolean }) => {
            await down(ctx, { force: flags.force });
        });

    // `restart`
    const restartCmd = cmd.command("restart").description("Stop and start fresh.");
    applyUpFlags(restartCmd, config);
    restartCmd.action(async (flags: UpFlags) => {
        await restart(ctx, toUpOptions(flags));
    });

    // `status`
    cmd.command("status")
        .description("Print status: pid, port, uptime, dependencies, launchd state.")
        .action(async () => {
            await printStatus(ctx);
        });

    // `attach`
    cmd.command("attach")
        .description("Tail the background log. Ctrl+C detaches the tail (the process keeps running).")
        .option("-n, --lines <n>", "how many trailing log lines to print first", parseLines, 50)
        .action(async (flags: { lines?: number }) => {
            await attach(ctx, { lines: flags.lines });
        });

    // `logs`
    cmd.command("logs")
        .description("Print the last N lines of the background log.")
        .option("-n, --lines <n>", "lines to print", parseLines, 200)
        .action(async (flags: { lines?: number }) => {
            await logs(ctx, { lines: flags.lines });
        });

    cmd.command("open")
        .description("Ensure the dashboard is up, print URL (+ optional QR), and open in the browser.")
        .option("-p, --port <n>", "override the default port")
        .option("--no-qr", "skip the phone-scan QR code")
        .option("--no-open", "print URL only; do not open the browser")
        .option(
            "-q, --query <kv>",
            "URL query param key=value (repeatable)",
            parseQueryParam,
            {} as Record<string, string>
        )
        .action(async (flags: OpenFlags) => {
            const query = flags.query;
            const hasQuery = query && Object.keys(query).length > 0;

            await openDashboard(ctx, {
                port: flags.port ? parsePort(flags.port) : undefined,
                qr: flags.qr === false ? false : undefined,
                openBrowser: flags.open !== false,
                query: hasQuery ? query : undefined,
            });
        });

    // `install` / `uninstall` only when the app opts into launchd.
    if (config.launchd?.available) {
        cmd.command("install")
            .description("Register a launchd plist so this dashboard survives reboot and respawns on crash.")
            .option("--force", "kill any conflicting process before installing")
            .option("-p, --port <n>", "override the default port")
            .action(async (flags: { force?: boolean; port?: string }) => {
                await install(ctx, {
                    force: flags.force,
                    port: flags.port ? parsePort(flags.port) : undefined,
                });
            });
        cmd.command("uninstall")
            .description("Remove the launchd plist registered by `install`.")
            .action(async () => {
                await uninstall(ctx);
            });
    }

    return cmd;
}
