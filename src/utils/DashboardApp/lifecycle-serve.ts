/**
 * DashboardApp serve-mode selection: which spawn command `up` / `install` / `dev`
 * actually run, and the foreground `dev` verb that restores the installed server.
 */
import { out } from "@genesiscz/utils/logger";
import { spawnDashboard } from "@genesiscz/utils/process/spawnDashboard";
import { terminalLocaleEnvRecord } from "@genesiscz/utils/terminal/locale";
import { resolveDashboardBindHost } from "./access";
import { isLaunchdInstalled, startLaunchd } from "./launchd";
import type { LifecycleContext } from "./lifecycle";
import { clearPid, writePid } from "./pidFile";
import { waitForPortFree } from "./portConflict";
import { readPreferences, writePreferences } from "./preferences";
import { waitForReady } from "./readiness";
import type { DashboardAppConfig, DownOptions, DownResult, StatusResult, UpOptions, UpResult } from "./types";

export function resolveSpawnCmd(config: DashboardAppConfig, opts: UpOptions = {}): string[] {
    if (opts.uiServe === "dev" && config.spawn.devCmd) {
        return [...config.spawn.devCmd];
    }

    if (opts.uiServe === "preview" && config.spawn.previewCmd) {
        return [...config.spawn.previewCmd];
    }

    return [...config.spawn.cmd];
}

/** The command the launchd plist carries: the mode `install` chose, unless this call names one. */
export function launchdSpawnCmd(config: DashboardAppConfig, opts: UpOptions): string[] {
    return resolveSpawnCmd(config, { ...opts, uiServe: opts.uiServe ?? readPreferences(config.key).launchdServe });
}

export function spawnEnv(config: DashboardAppConfig): Record<string, string | undefined> {
    return {
        ...config.spawn.env,
        ...terminalLocaleEnvRecord(),
        // UI and server children alike read their listen address from here: loopback by
        // default, the registry entry or the per-dashboard preferences file may widen it.
        DASHBOARD_BIND_HOST: resolveDashboardBindHost(config),
        ...(config.type === "ui" ? { FORCE_COLOR: "1", BROWSER: "none" } : {}),
    };
}

export function shouldOpenBrowser(config: DashboardAppConfig, opts: UpOptions): boolean {
    if (config.type !== "ui") {
        return false;
    }

    if (opts.open === false) {
        return false;
    }

    // Commander's `--no-open` negatable flag defaults `open` to true; per-app
    // `openBrowser.enabled` is the source of truth (dev-dashboard: false).
    return config.openBrowser?.enabled ?? false;
}

/** Remember `install --preview` so later `up` / `restart` rewrite the plist from it. */
export function persistInstallServeMode(key: string, preview: boolean): "preview" | undefined {
    const launchdServe = preview ? ("preview" as const) : undefined;
    writePreferences(key, { launchdServe });
    return launchdServe;
}

/**
 * Run `spawn.devCmd` in the foreground in place of whatever serves the port, and bring that back
 * when the dev server exits: a launchd agent is booted out first and started again afterwards, a
 * background instance is stopped and started again. Ctrl+C is the normal way out.
 */
export async function runDev(input: {
    ctx: LifecycleContext;
    opts?: UpOptions;
    down: (ctx: LifecycleContext, opts?: DownOptions) => Promise<DownResult>;
    up: (ctx: LifecycleContext, opts?: UpOptions) => Promise<UpResult>;
    status: (ctx: LifecycleContext) => Promise<StatusResult>;
}): Promise<never> {
    const { ctx, down, up, status } = input;
    const opts = input.opts ?? {};
    const { config } = ctx;
    const port = opts.port ?? ctx.port;
    const devCmd = config.spawn.devCmd;

    if (!devCmd) {
        throw new Error(`${config.key} does not define a dev command.`);
    }

    const launchdManaged = Boolean(config.launchd?.available && isLaunchdInstalled(ctx.plistLabel));
    const wasRunning = launchdManaged || (await status(ctx)).running;

    if (wasRunning) {
        await down(ctx, { force: true });
        await waitForPortFree(port, 5_000, { killIfHeld: true, dashboardKey: config.key });
    }

    const restore = async (): Promise<void> => {
        if (launchdManaged) {
            out.log.step(`Starting launchd agent ${ctx.plistLabel} again…`);
            await waitForPortFree(port, 5_000, { killIfHeld: true, dashboardKey: config.key });
            await startLaunchd(ctx.plistLabel);
            const ok = await waitForReady(config.readiness, { port, logFile: ctx.logFile });

            if (ok.ready) {
                out.log.success(`${config.name ?? config.key} back on http://localhost:${port} · launchd`);
            } else {
                out.warn(
                    `Launchd agent did not come back: ${ok.detail ?? "unknown"}\n  Check: launchctl print gui/$UID/${ctx.plistLabel}\n  Log: ${ctx.logFile}`
                );
            }

            return;
        }

        if (wasRunning) {
            await up(ctx, { port, open: false, skipInstallPrompt: true });
        }
    };

    out.log.step(
        `${config.name ?? config.key} dev server in the foreground; stop it to bring the installed server back.`
    );
    writePid(config.key, process.pid);
    let exitCode = 1;

    try {
        exitCode = await spawnDashboard({
            cmd: [...devCmd],
            cwd: config.spawn.cwd,
            env: {
                ...spawnEnv(config),
                ...(shouldOpenBrowser(config, opts) ? { DASHBOARD_OPEN_BROWSER: "1" } : {}),
            },
        });
    } finally {
        clearPid(config.key);
        await restore();
    }

    process.exit(exitCode);
}
