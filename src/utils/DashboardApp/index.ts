/**
 * Public API for the DashboardApp factory.
 *
 * Usage from a tool:
 *
 *   import { defineDashboardApp } from "@app/utils/DashboardApp";
 *
 *   const app = defineDashboardApp({
 *       type: "ui",
 *       key: "clarity",
 *       commandName: "ui",
 *       description: "Launch the Clarity dashboard",
 *       spawn: { cmd: buildViteDevCmd({ configPath, strictPort: true }), cwd: PROJECT_ROOT },
 *       bindHost: "127.0.0.1", // default; use "0.0.0.0" for LAN/tunnel (see dev-dashboard)
 *       readiness: { kind: "http" },
 *       openBrowser: { enabled: true },
 *       launchd: { available: true },
 *   });
 *
 *   parentCommand.addCommand(app.commanderCommand);
 *
 * See `/Users/Martin/.claude/plans/golden-wandering-pillow.md` for the
 * full design.
 */
import { DASHBOARDS } from "@app/utils/ui/dashboards";
import { buildCommanderCommand } from "./commander";
import {
    attach as attachLifecycle,
    buildLifecycleContext,
    down as downLifecycle,
    install as installLifecycle,
    logs as logsLifecycle,
    restart as restartLifecycle,
    status as statusLifecycle,
    uninstall as uninstallLifecycle,
    up as upLifecycle,
} from "./lifecycle";
import { logFilePath, pidFilePath } from "./pidFile";
import type {
    AttachOptions,
    DashboardApp,
    DashboardAppConfig,
    DownOptions,
    DownResult,
    InstallOptions,
    StatusResult,
    UpOptions,
    UpResult,
} from "./types";

export type {
    AttachOptions,
    DashboardApp,
    DashboardAppConfig,
    DashboardAppType,
    DashboardBindHost,
    DashboardDependency,
    DependencyPolicy,
    DependencyStatus,
    DownOptions,
    DownResult,
    InstallOptions,
    PreflightWarning,
    ReadinessProbe,
    StatusResult,
    UpOptions,
    UpResult,
} from "./types";
export type { ViteDevCmdOptions } from "./viteSpawn";
export { buildViteDevCmd, DEFAULT_BIND_HOST, resolveViteEntry } from "./viteSpawn";

function resolvePort(config: DashboardAppConfig): number {
    if (typeof config.port === "number") {
        return config.port;
    }
    if (config.type === "ui") {
        const entry = (DASHBOARDS as Record<string, { port: number } | undefined>)[config.key];
        if (entry) {
            return entry.port;
        }
    }
    throw new Error(
        `DashboardApp "${config.key}": no port resolved. Pass \`port\` explicitly or register the key in src/utils/ui/dashboards.ts.`
    );
}

export function defineDashboardApp(config: DashboardAppConfig): DashboardApp {
    const port = resolvePort(config);
    const ctx = buildLifecycleContext(config, port);
    const commanderCommand = buildCommanderCommand({ config, ctx });

    const app: DashboardApp = {
        config: Object.freeze({ ...config }),
        port,
        pidFile: pidFilePath(config.key),
        logFile: logFilePath(config.key),
        commanderCommand,
        up(opts?: UpOptions): Promise<UpResult> {
            return upLifecycle(ctx, opts);
        },
        down(opts?: DownOptions): Promise<DownResult> {
            return downLifecycle(ctx, opts);
        },
        restart(opts?: UpOptions): Promise<UpResult> {
            return restartLifecycle(ctx, opts);
        },
        status(): Promise<StatusResult> {
            return statusLifecycle(ctx);
        },
        attach(opts?: AttachOptions): Promise<void> {
            return attachLifecycle(ctx, opts);
        },
        logs(opts?: { lines?: number }): Promise<void> {
            return logsLifecycle(ctx, opts);
        },
        async install(opts?: InstallOptions): Promise<void> {
            await installLifecycle(ctx, opts);
        },
        async uninstall(): Promise<void> {
            await uninstallLifecycle(ctx);
        },
    };

    return app;
}
