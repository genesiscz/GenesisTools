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
 *     install      (only if launchd.available)
 *     uninstall    (only if launchd.available)
 *
 * Global flag on every verb AND the no-verb default:
 *     -i, --interactive   force the menu
 */
import { Command } from "commander";
import { attach, down, install, type LifecycleContext, logs, printStatus, restart, uninstall, up } from "./lifecycle";
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
}

function toUpOptions(flags: UpFlags) {
    return {
        foreground: flags.foreground,
        port: flags.port ? Number.parseInt(flags.port, 10) : undefined,
        force: flags.force,
        open: flags.open,
        interactive: flags.interactive,
    };
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
    cmd.command("up")
        .description("Start (default: background). Use --foreground to block.")
        .option("-f, --foreground", "run in the foreground (block until killed)")
        .option("-p, --port <n>", "override the default port")
        .option("--force", "kill any conflicting process before starting")
        .option("--no-open", "do not auto-open the browser (UI apps only)")
        .option("-i, --interactive", "force the menu")
        .action(async (flags: UpFlags) => {
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
    cmd.command("restart")
        .description("Stop and start fresh.")
        .option("-f, --foreground", "run in the foreground (block until killed)")
        .option("-p, --port <n>", "override the default port")
        .option("--force", "kill any conflicting process before starting")
        .option("--no-open", "do not auto-open the browser (UI apps only)")
        .option("-i, --interactive", "force the menu")
        .action(async (flags: UpFlags) => {
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
        .option("-n, --lines <n>", "how many trailing log lines to print first", (v) => Number.parseInt(v, 10), 50)
        .action(async (flags: { lines?: number }) => {
            await attach(ctx, { lines: flags.lines });
        });

    // `logs`
    cmd.command("logs")
        .description("Print the last N lines of the background log.")
        .option("-n, --lines <n>", "lines to print", (v) => Number.parseInt(v, 10), 200)
        .action(async (flags: { lines?: number }) => {
            await logs(ctx, { lines: flags.lines });
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
                    port: flags.port ? Number.parseInt(flags.port, 10) : undefined,
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
