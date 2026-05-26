/**
 * DashboardApp lifecycle orchestration — the `up` / `down` / `restart` /
 * `status` / `attach` / `logs` / `install` / `uninstall` operations.
 *
 * Each operation is a free function so it can be tested in isolation against
 * a synthetic DashboardApp instance. `commander.ts` wires verbs to these
 * functions; the imperative `DashboardApp` API on `types.ts` does the same.
 */
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { logger, out } from "@app/logger";
import { Browser } from "@app/utils/browser";
import { isInteractive, suggestCommand } from "@app/utils/cli";
import { getPortOwner } from "@app/utils/network";
import { spawnDashboard } from "@app/utils/process/spawnDashboard";
import { stripAnsi } from "@app/utils/string";
import * as p from "@clack/prompts";
import pc from "picocolors";
import {
    DashboardNotReadyError,
    openDashboardAccess,
    presentDashboardAccess,
    resolveDashboardAccessPresentation,
    resolveDashboardBrowserUrl,
} from "./access";
import { spawnDetached } from "./detach";
import {
    bootoutLaunchd,
    defaultPlistLabel,
    installLaunchd,
    isLaunchdInstalled,
    refreshLaunchd,
    uninstallLaunchd,
} from "./launchd";
import { printDevServerBanner, readLogTail, resetLogFile } from "./logSession";
import {
    describeConflict,
    promptDependencyStart,
    promptForeignMenu,
    promptLaunchdInstall,
    promptMineMenu,
} from "./menu";
import { clearPid, logFilePath, pidFilePath, pidFileStartTime, readPid, writePid } from "./pidFile";
import { checkPortConflict, killPortOwner, waitForPortFree } from "./portConflict";
import { readPreferences, writePreferences } from "./preferences";
import { waitForReady, waitForUrlReady } from "./readiness";
import type {
    DashboardAppConfig,
    DependencyStatus,
    DownOptions,
    DownResult,
    InstallOptions,
    OpenOptions,
    PreflightWarning,
    StatusResult,
    UpOptions,
    UpResult,
} from "./types";
import { DEFAULT_BIND_HOST } from "./viteSpawn";

export interface LifecycleContext {
    config: DashboardAppConfig;
    port: number;
    pidFile: string;
    logFile: string;
    plistLabel: string;
}

export function buildLifecycleContext(config: DashboardAppConfig, resolvedPort: number): LifecycleContext {
    return {
        config,
        port: resolvedPort,
        pidFile: pidFilePath(config.key),
        logFile: logFilePath(config.key),
        plistLabel: config.launchd?.label ?? defaultPlistLabel(config.key),
    };
}

function spawnEnv(config: DashboardAppConfig): Record<string, string | undefined> {
    return {
        ...config.spawn.env,
        ...(config.type === "ui"
            ? {
                  FORCE_COLOR: "1",
                  BROWSER: "none",
                  DASHBOARD_BIND_HOST: config.bindHost ?? DEFAULT_BIND_HOST,
              }
            : {}),
    };
}

export async function up(ctx: LifecycleContext, opts: UpOptions = {}): Promise<UpResult> {
    const { config } = ctx;
    const port = opts.port ?? ctx.port;

    await runPreflight(ctx);
    await resolveDependencies(ctx, opts, "up");

    // 3. Port conflict check — reclaim stale orphans, prompt on foreign holders.
    const portReady = await preparePort(ctx, port, opts);

    if (!portReady.proceed) {
        return portReady.result;
    }

    // 4. Launchd first-run prompt (TTY only, opt-in apps only).
    if (
        config.launchd?.available &&
        !opts.foreground &&
        !opts.skipInstallPrompt &&
        !readPreferences(config.key).launchdInstalled &&
        !readPreferences(config.key).launchdPromptDismissed
    ) {
        const wantInstall = await promptLaunchdInstall(config.key);

        if (wantInstall === true) {
            return finishLaunchdStart(ctx, port, opts);
        }

        if (wantInstall === false) {
            writePreferences(config.key, { launchdPromptDismissed: true });
        }
    }

    // If launchd is already installed, prefer launchd over a duplicate manual spawn.
    if (config.launchd?.available && !opts.foreground && isLaunchdInstalled(ctx.plistLabel)) {
        return finishLaunchdStart(ctx, port, { ...opts, skipInstallPrompt: true });
    }

    // 5. Spawn — foreground OR background.
    const mode: "foreground" | "background" = opts.foreground ? "foreground" : "background";

    if (mode === "foreground") {
        // spawnDashboard blocks until the child exits and handles signals + orphan-detection.
        writePid(config.key, process.pid);
        try {
            const exitCode = await spawnDashboard({
                cmd: [...config.spawn.cmd],
                cwd: config.spawn.cwd,
                env: {
                    ...spawnEnv(config),
                    ...(shouldOpenBrowser(config, opts) ? { DASHBOARD_OPEN_BROWSER: "1" } : {}),
                },
            });
            clearPid(config.key);
            process.exit(exitCode);
        } catch (err) {
            clearPid(config.key);
            throw err;
        }
    }

    // Background: detached spawn with stdio → logfile.
    resetLogFile(config.key);
    const { pid } = spawnDetached({
        cmd: [...config.spawn.cmd],
        cwd: config.spawn.cwd,
        env: spawnEnv(config),
        logFile: ctx.logFile,
    });
    writePid(config.key, pid);

    const readiness = await waitForReady(config.readiness, { port, logFile: ctx.logFile });
    if (!readiness.ready) {
        out.warn(
            `Readiness check failed: ${readiness.detail ?? "(no detail)"}\n  Started anyway — tail the log: tools ${config.key} ${config.commandName} attach`
        );
    } else {
        out.log.success(
            `${config.name ?? config.key} ready on http://localhost:${port}  (pid ${pid})\n  logs → ${ctx.logFile}`
        );

        if (config.type === "ui") {
            await Bun.sleep(400);
            printDevServerBanner(ctx.logFile, port, { bindHost: config.bindHost });
        }
    }

    // Browser-open (UI only) — wait until the URL actually serves (not 502 gateway).
    if (config.type === "ui" && shouldOpenBrowser(config, opts)) {
        await openBrowserWhenReady(config, port);
    }

    return { started: true, port, mode, pid, logPath: ctx.logFile };
}

type PreparePortResult = { proceed: true } | { proceed: false; result: UpResult };

async function preparePort(ctx: LifecycleContext, port: number, opts: UpOptions): Promise<PreparePortResult> {
    const { config } = ctx;
    const conflict = await checkPortConflict(config.key, port);
    logger.debug({ conflict: describeConflict(conflict) }, `[${config.key}] port conflict check`);

    if (conflict.state === "free") {
        return { proceed: true };
    }

    if (conflict.state === "mine") {
        if (opts.force || opts.replaceRunning) {
            out.log.step(`Stopping running instance (pid ${conflict.pid}) before start`);
            await down(ctx, { force: true });
            await waitForPortFree(port, 5_000, { killIfHeld: true, dashboardKey: config.key });
            return { proceed: true };
        }

        const result = await handleMineMenu(ctx, conflict.pid, opts, port);
        return { proceed: false, result };
    }

    if (conflict.state === "stale") {
        out.log.step(`Reclaiming port ${port} from stale pid ${conflict.owner.pid} (${conflict.owner.command})`);
        await killPortOwner(conflict.owner);
        clearPid(config.key);

        const freed = await waitForPortFree(port, 5_000, {
            killIfHeld: true,
            expectOwnerPid: conflict.owner.pid,
        });

        if (!freed) {
            out.error(`Port ${port} still held after reclaiming stale pid ${conflict.owner.pid}`);
            return {
                proceed: false,
                result: { started: false, port, mode: opts.foreground ? "foreground" : "background" },
            };
        }

        return { proceed: true };
    }

    if (opts.force && conflict.owner) {
        out.log.step(`Killing port owner pid ${conflict.owner.pid} (${conflict.owner.command})`);
        await killPortOwner(conflict.owner);
        clearPid(config.key);
        await waitForPortFree(port, 5_000, {
            killIfHeld: true,
            expectOwnerPid: conflict.owner.pid,
            sameUserOnly: conflict.owner.sameUser,
        });
        return { proceed: true };
    }

    const owner = conflict.owner;
    const ownerDesc = owner ? `pid ${owner.pid} (${owner.command})` : "(unknown owner)";
    out.error(`Port ${port} is held by ${ownerDesc}.`);

    if (owner) {
        const choice = await promptForeignMenu(port, owner.pid, owner.command, owner.sameUser);

        if (choice === "kill-and-up") {
            await killPortOwner(owner);
            clearPid(config.key);
            await waitForPortFree(port, 5_000, {
                killIfHeld: true,
                expectOwnerPid: owner.pid,
                sameUserOnly: owner.sameUser,
            });
            return { proceed: true };
        }

        if (choice === null) {
            out.info(`  Use --force to kill the owner and start: ${suggestCommand("tools", { add: ["--force"] })}`);
        }
    }

    return {
        proceed: false,
        result: { started: false, port, mode: opts.foreground ? "foreground" : "background" },
    };
}

async function finishLaunchdStart(ctx: LifecycleContext, port: number, opts: UpOptions): Promise<UpResult> {
    const { config } = ctx;
    const newlyInstalled = !isLaunchdInstalled(ctx.plistLabel);

    resetLogFile(config.key);

    if (newlyInstalled) {
        await installLaunchd({
            label: ctx.plistLabel,
            command: config.spawn.cmd,
            cwd: config.spawn.cwd,
            env: spawnEnv(config),
            logFile: ctx.logFile,
        });
        writePreferences(config.key, { launchdInstalled: true, launchdPromptDismissed: false });
        out.log.success(`Launchd plist installed at ~/Library/LaunchAgents/${ctx.plistLabel}.plist`);
    } else {
        const portHeld = await getPortOwner(port);

        if (portHeld) {
            out.log.step(`Restarting launchd agent ${ctx.plistLabel}…`);
            await bootoutLaunchd(ctx.plistLabel).catch((err) => {
                logger.warn({ err }, `[${config.key}] launchd bootout failed`);
            });
            out.log.step(`Waiting for port ${port} to free…`);
            await waitForPortFree(port, 5_000, { killIfHeld: true, dashboardKey: config.key });
        }

        out.log.step(`Starting launchd agent ${ctx.plistLabel}…`);
        await refreshLaunchd({
            label: ctx.plistLabel,
            command: config.spawn.cmd,
            cwd: config.spawn.cwd,
            env: spawnEnv(config),
            logFile: ctx.logFile,
        });
    }

    out.log.step(`Waiting for ${config.name ?? config.key} to respond on :${port}…`);
    const ok = await waitForReady(config.readiness, { port, logFile: ctx.logFile });
    const owner = ok.ready ? await getPortOwner(port) : null;
    const pid = owner?.pid ?? readPid(config.key) ?? undefined;

    if (owner?.pid) {
        writePid(config.key, owner.pid);
    }

    if (ok.ready) {
        out.log.success(
            `${config.name ?? config.key} ready on http://localhost:${port}${pid ? ` (pid ${pid})` : ""} · launchd\n  logs → ${ctx.logFile}`
        );

        if (config.type === "ui") {
            await Bun.sleep(400);
            printDevServerBanner(ctx.logFile, port, { bindHost: config.bindHost });
        }

        if (config.type === "ui" && shouldOpenBrowser(config, opts)) {
            await openBrowserWhenReady(config, port);
        }
    } else {
        out.warn(
            `Launchd agent did not become ready: ${ok.detail ?? "unknown"}\n  Check: launchctl print gui/$UID/${ctx.plistLabel}\n  Log: ${ctx.logFile}`
        );
    }

    return {
        started: ok.ready,
        port,
        mode: "background",
        pid,
        logPath: ctx.logFile,
    };
}

async function handleMineMenu(
    ctx: LifecycleContext,
    pid: number,
    opts: UpOptions,
    effectivePort: number
): Promise<UpResult> {
    const { config } = ctx;
    const port = effectivePort;
    const choice = await promptMineMenu(port, pid, {
        canOpen: config.type === "ui" || Boolean(config.access?.qr),
    });

    if (choice === null) {
        // Non-TTY: print the verbs and exit.
        out.info(
            `Already running (pid ${pid} on :${port}). Try one of:\n` +
                `  tools <tool> ${config.commandName} restart\n` +
                `  tools <tool> ${config.commandName} attach\n` +
                `  tools <tool> ${config.commandName} status\n` +
                `  tools <tool> ${config.commandName} down`
        );
        return { started: false, port, mode: opts.foreground ? "foreground" : "background" };
    }

    if (choice === "restart") {
        await down(ctx, {});
        return up(ctx, { ...opts, interactive: false, open: opts.open ?? config.openBrowser?.enabled });
    }
    if (choice === "down") {
        await down(ctx, {});
        return { started: false, port, mode: "background" };
    }
    if (choice === "attach") {
        await attach(ctx, {});
        return { started: false, port, mode: "background", pid };
    }
    if (choice === "status") {
        await printStatus(ctx);
        return { started: false, port, mode: "background", pid };
    }
    if (choice === "open") {
        const browserUrl = resolveDashboardBrowserUrl(config, port);
        if (config.type === "ui") {
            await openBrowserWhenReady(config, port);
        } else if (config.access?.qr) {
            presentDashboardAccess(resolveDashboardAccessPresentation(config, port, { url: browserUrl }));
            await Browser.open(browserUrl).catch((err) => {
                logger.warn({ err }, `[${config.key}] browser open failed`);
            });
        }
        return { started: false, port, mode: "background", pid };
    }
    return { started: false, port, mode: "background" };
}

export async function down(ctx: LifecycleContext, opts: DownOptions = {}): Promise<DownResult> {
    const { config } = ctx;
    const portOwner = await getPortOwner(ctx.port);
    const filePid = readPid(config.key);
    const targetPid = portOwner?.pid ?? filePid;
    const launchdManaged = Boolean(config.launchd?.available && isLaunchdInstalled(ctx.plistLabel));
    let didBootout = false;

    if (!targetPid && !launchdManaged) {
        out.info(`${config.name ?? config.key} is not running.`);
        clearPid(config.key);
        return { stopped: false };
    }

    const aliveBeforeStop = targetPid !== null && isProcessAlive(targetPid);

    if (launchdManaged) {
        out.log.step(`Stopping launchd agent ${ctx.plistLabel}…`);
        await bootoutLaunchd(ctx.plistLabel).catch((err) => {
            logger.warn({ err }, `[${config.key}] launchd bootout failed`);
        });
        didBootout = true;
    }

    const pid = (await getPortOwner(ctx.port))?.pid ?? targetPid;

    if (!pid) {
        clearPid(config.key);
        out.log.success(`${config.name ?? config.key} stopped${didBootout ? " (launchd agent unloaded)" : ""}.`);
        return { stopped: true };
    }

    if (isProcessAlive(pid)) {
        try {
            process.kill(pid, "SIGTERM");
        } catch (err) {
            logger.warn({ err, pid }, `[${config.key}] SIGTERM failed`);
        }

        out.log.step(`Waiting for ${config.name ?? config.key} (pid ${pid}) to exit…`);
        const force = opts.force ?? true;
        const gracePeriodMs = 5_000;
        const deadline = Date.now() + gracePeriodMs;

        while (Date.now() < deadline) {
            if (!isProcessAlive(pid)) {
                break;
            }

            await Bun.sleep(200);
        }

        if (isProcessAlive(pid) && force) {
            try {
                process.kill(pid, "SIGKILL");
            } catch (err) {
                logger.warn({ err, pid }, `[${config.key}] SIGKILL failed`);
            }

            await Bun.sleep(500);
        }

        if (isProcessAlive(pid)) {
            out.error(`Failed to stop pid ${pid}; it may need manual cleanup.`);
            return { stopped: false, pid };
        }
    }

    if (await getPortOwner(ctx.port)) {
        out.log.step(`Waiting for port ${ctx.port} to free…`);
        await waitForPortFree(ctx.port, 2_000, { killIfHeld: true, dashboardKey: config.key });
    }

    clearPid(config.key);

    if (didBootout) {
        out.log.success(`${config.name ?? config.key} stopped (pid ${pid})`);
    } else if (!aliveBeforeStop) {
        out.log.success(`${config.name ?? config.key} stopped (pid ${pid} was not running; cleaned up stale state)`);
    } else {
        out.log.success(`${config.name ?? config.key} stopped (pid ${pid})`);
    }

    return { stopped: true, pid };
}

export async function restart(ctx: LifecycleContext, opts: UpOptions = {}): Promise<UpResult> {
    await down(ctx, {});
    return up(ctx, opts);
}

export async function status(ctx: LifecycleContext): Promise<StatusResult> {
    const { config, port } = ctx;
    let pid = readPid(config.key);
    let running = pid !== null && isProcessAlive(pid);

    if (!running) {
        const owner = await getPortOwner(port);

        if (owner?.pid && isProcessAlive(owner.pid)) {
            pid = owner.pid;
            running = true;
            writePid(config.key, owner.pid);
        }
    }

    const startTime = pid ? pidFileStartTime(config.key) : null;

    const dependencies: DependencyStatus[] = [];
    for (const dep of config.dependencies ?? []) {
        const depStatus = await dep.app.status();
        dependencies.push({
            key: depStatus.key,
            running: depStatus.running,
            pid: depStatus.pid,
            port: depStatus.port,
        });
    }

    let preflightWarnings: PreflightWarning[] = [];
    if (config.preflight) {
        try {
            const { warnings } = await config.preflight();
            preflightWarnings = warnings;
        } catch (err) {
            logger.debug({ err }, `[${config.key}] preflight threw during status`);
        }
    }

    return {
        key: config.key,
        type: config.type,
        running,
        pid: pid ?? undefined,
        port,
        uptimeMs: pid && startTime ? Date.now() - startTime.getTime() : undefined,
        logPath: ctx.logFile,
        launchdAvailable: Boolean(config.launchd?.available),
        launchdInstalled: config.launchd?.available ? isLaunchdInstalled(ctx.plistLabel) : false,
        dependencies,
        preflightWarnings,
    };
}

export async function printStatus(ctx: LifecycleContext): Promise<void> {
    const s = await status(ctx);
    const lines: string[] = [];
    lines.push(`${s.key} (${s.type}): ${s.running ? `running · pid ${s.pid}` : "not running"}`);
    lines.push(`  port: ${s.port}`);
    if (s.running && s.uptimeMs) {
        lines.push(`  uptime: ${formatDuration(s.uptimeMs)}`);
    }
    if (s.launchdAvailable) {
        lines.push(`  launchd: ${s.launchdInstalled ? "installed" : "not installed"}`);
    }
    lines.push(`  log: ${s.logPath}`);
    for (const dep of s.dependencies) {
        lines.push(`  dep ${dep.key}: ${dep.running ? `running · pid ${dep.pid}` : "not running"} (port ${dep.port})`);
    }
    for (const w of s.preflightWarnings) {
        lines.push(`  ⚠ ${w.service}: ${w.error}${w.fix ? ` (fix: ${w.fix})` : ""}`);
    }
    out.println(lines.join("\n"));
}

function formatDuration(ms: number): string {
    if (ms < 1_000) {
        return `${ms}ms`;
    }
    if (ms < 60_000) {
        return `${(ms / 1_000).toFixed(1)}s`;
    }
    if (ms < 3_600_000) {
        return `${(ms / 60_000).toFixed(1)}m`;
    }
    return `${(ms / 3_600_000).toFixed(1)}h`;
}

export async function attach(ctx: LifecycleContext, opts: { lines?: number } = {}): Promise<void> {
    const { logFile } = ctx;
    if (!existsSync(logFile)) {
        out.info(`No log file at ${logFile} — nothing to attach to.`);
        return;
    }

    const tail = readLogTail(logFile, opts.lines ?? 50, true);
    const isTty = Boolean(process.stdout.isTTY);
    out.print(isTty ? tail : stripAnsi(tail));

    if (!tail.endsWith("\n")) {
        out.print("\n");
    }

    out.info(`\n--- Attached (Ctrl+C to detach the tail; the process keeps running) ---`);

    let pos = statSync(logFile).size;

    let interrupted = false;
    const handler = () => {
        interrupted = true;
    };
    process.on("SIGINT", handler);

    try {
        while (!interrupted) {
            await Bun.sleep(150);
            if (!existsSync(logFile)) {
                continue;
            }
            const size = statSync(logFile).size;
            if (size <= pos) {
                continue;
            }
            const fd = openSync(logFile, "r");
            try {
                const buf = Buffer.alloc(size - pos);
                const read = readSync(fd, buf, 0, buf.length, pos);
                pos += read;
                const chunk = buf.subarray(0, read).toString();
                out.print(isTty ? chunk : stripAnsi(chunk));
            } finally {
                closeSync(fd);
            }
        }
    } finally {
        process.off("SIGINT", handler);
    }
}

export async function logs(ctx: LifecycleContext, opts: { lines?: number; sessionOnly?: boolean } = {}): Promise<void> {
    const { logFile } = ctx;

    if (!existsSync(logFile)) {
        out.info(`No log file at ${logFile}.`);
        return;
    }

    const sessionOnly = opts.sessionOnly ?? true;
    const tail = readLogTail(logFile, opts.lines ?? 200, sessionOnly);
    const isTty = Boolean(process.stdout.isTTY);
    out.print(isTty ? tail : stripAnsi(tail));

    if (tail.length > 0 && !tail.endsWith("\n")) {
        out.print("\n");
    }
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

async function openBrowserWhenReady(config: DashboardAppConfig, port: number): Promise<void> {
    const browserUrl = resolveDashboardBrowserUrl(config, port);

    if (config.access?.qr) {
        presentDashboardAccess(resolveDashboardAccessPresentation(config, port, { url: browserUrl }));
    }

    const ready = await waitForUrlReady(browserUrl, 20_000);

    if (!ready.ready) {
        logger.warn({ browserUrl, detail: ready.detail }, `[${config.key}] browser open skipped — URL not ready`);
        out.warn(
            `Skipping browser open — page not ready yet (${ready.detail ?? "timeout"})\n  Open manually: ${browserUrl}`
        );
        return;
    }

    await Browser.open(browserUrl).catch((err) => {
        logger.warn({ err }, `[${config.key}] browser open failed`);
    });
}

export async function install(ctx: LifecycleContext, opts: InstallOptions = {}): Promise<void> {
    const { config } = ctx;
    const port = opts.port ?? ctx.port;

    if (!config.launchd?.available) {
        throw new Error(`${config.key} does not opt into launchd integration.`);
    }

    if (process.platform !== "darwin") {
        throw new Error("Launchd integration is macOS-only.");
    }

    await runPreflight(ctx);
    await resolveDependencies(ctx, { ...opts, open: false, skipInstallPrompt: true, replaceRunning: true }, "install");

    const portReady = await preparePort(ctx, port, {
        force: opts.force,
        replaceRunning: true,
        open: false,
        skipInstallPrompt: true,
    });

    if (!portReady.proceed) {
        throw new Error(`${config.name ?? config.key}: port ${port} is still in use.`);
    }

    const result = await finishLaunchdStart(ctx, port, { open: false, skipInstallPrompt: true });

    if (!result.started) {
        throw new Error(
            `${config.name ?? config.key} launchd install failed — not ready on :${port}. See ${ctx.logFile}`
        );
    }
}

async function runPreflight(ctx: LifecycleContext): Promise<void> {
    const { config } = ctx;

    if (!config.preflight) {
        return;
    }

    try {
        const { warnings } = await config.preflight();

        for (const w of warnings) {
            logger.warn({ service: w.service, fix: w.fix }, w.error);
            out.warn(`${w.service}: ${w.error}${w.fix ? `\n  Fix: ${w.fix}` : ""}`);
        }
    } catch (err) {
        logger.warn({ err }, `[${config.key}] preflight threw`);
    }
}

type StartMode = "up" | "install";

async function resolveDependencies(ctx: LifecycleContext, opts: UpOptions, mode: StartMode): Promise<void> {
    const { config } = ctx;

    for (const dep of config.dependencies ?? []) {
        const depStatus = await dep.app.status();

        if (depStatus.running) {
            continue;
        }

        const startDep = async () => {
            if (mode === "install" && dep.app.config.launchd?.available) {
                await dep.app.install({ force: opts.force });
                return;
            }

            await dep.app.up({
                open: false,
                force: opts.force,
                skipInstallPrompt: true,
                replaceRunning: opts.replaceRunning,
            });
        };

        if (dep.policy === "auto") {
            out.log.step(`${mode === "install" ? "Installing" : "Starting"} dependency ${dep.app.config.key}...`);
            await startDep();
            continue;
        }

        if (dep.policy === "warn") {
            out.warn(`Dependency ${dep.app.config.key} is not running.`);
            continue;
        }

        if (mode === "install") {
            out.log.step(`Installing dependency ${dep.app.config.key}...`);
            await startDep();
            continue;
        }

        const choice = await promptDependencyStart(dep.app.config.key, config.key);

        if (choice === "abort") {
            throw new Error(`Aborted: dependency ${dep.app.config.key} is required for ${config.key}`);
        }

        if (choice === "start") {
            await startDep();
        } else if (choice === null) {
            out.warn(
                `Dependency ${dep.app.config.key} is not running. Run \`tools ${dep.app.config.commandName} up\` on the dependency to start it.`
            );
        }
    }
}

export async function uninstall(ctx: LifecycleContext): Promise<void> {
    await bootoutLaunchd(ctx.plistLabel).catch((err) => {
        logger.warn({ err }, `[${ctx.config.key}] launchd bootout failed`);
    });

    const owner = await getPortOwner(ctx.port);

    if (owner?.pid && isProcessAlive(owner.pid)) {
        await killPortOwner(owner);
    }

    clearPid(ctx.config.key);
    await uninstallLaunchd(ctx.plistLabel);
    writePreferences(ctx.config.key, { launchdInstalled: false });
    out.log.success(`Launchd plist removed.`);
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        logger.debug({ err, pid }, "process liveness probe failed");
        return false;
    }
}

export function dashboardUrlWithQuery(
    config: DashboardAppConfig,
    port: number,
    query?: Record<string, string>,
    baseUrl?: string
): string {
    const url = new URL(baseUrl ?? resolveDashboardBrowserUrl(config, port));

    if (query) {
        for (const [key, value] of Object.entries(query)) {
            url.searchParams.set(key, value);
        }
    }

    return url.toString();
}

function readinessProbePath(config: DashboardAppConfig): string {
    const probe = config.readiness;

    if (probe?.kind === "http") {
        return probe.path ?? "/";
    }

    return "/";
}

async function isDashboardReady(ctx: LifecycleContext, port: number): Promise<boolean> {
    const path = readinessProbePath(ctx.config);
    const ready = await waitForUrlReady(`http://127.0.0.1:${port}${path}`, 2_000);

    return ready.ready;
}

async function ensureDashboardRunningForOpen(ctx: LifecycleContext, port: number): Promise<void> {
    if (await isDashboardReady(ctx, port)) {
        return;
    }

    const { config } = ctx;
    const serveHint = config.open?.serveHint;

    if (!isInteractive()) {
        out.printlnErr(`error: ${config.name ?? config.key} is not running on port ${port}.`);

        if (serveHint) {
            out.printlnErr(suggestCommand(serveHint.tool, { replaceCommand: serveHint.replaceCommand }));
        }

        process.exit(1);
    }

    const shouldStart = await p.confirm({
        message: `${config.name ?? config.key} is not running on port ${port}. Start it now?`,
        initialValue: true,
    });

    if (p.isCancel(shouldStart) || !shouldStart) {
        p.cancel("Dashboard not opened.");
        process.exit(0);
    }

    out.printlnErr(pc.dim(`▸ Starting ${config.name ?? config.key} on :${port}`));

    const result = await up(ctx, { port, open: false });

    if (!result.started && !(await isDashboardReady(ctx, port))) {
        out.printlnErr(`error: ${config.name ?? config.key} did not become ready.`);
        out.printlnErr(pc.dim(`  logs → ${ctx.logFile}`));
        process.exit(1);
    }
}

export async function openDashboard(ctx: LifecycleContext, opts: OpenOptions = {}): Promise<void> {
    const { config } = ctx;
    const port = opts.port ?? ctx.port;

    if (Number.isNaN(port) || port < 1 || port > 65_535) {
        out.printlnErr(`error: Invalid port: ${opts.port ?? port}`);
        process.exit(1);
    }

    if (config.open?.preflight) {
        await config.open.preflight();
    }

    await ensureDashboardRunningForOpen(ctx, port);

    const url = dashboardUrlWithQuery(config, port, opts.query);
    const presentation = resolveDashboardAccessPresentation(config, port, { url });
    const showQr = opts.qr === false ? false : Boolean(opts.qr ?? config.access?.qr);

    try {
        await openDashboardAccess({
            ...presentation,
            qr: showQr ? (presentation.qr ?? true) : undefined,
            openBrowser: opts.openBrowser !== false,
        });
    } catch (err) {
        // openDashboardAccess used to call process.exit(1) inline; that has
        // been replaced by a DashboardNotReadyError so programmatic callers
        // can recover. The CLI entrypoint still wants a non-zero exit, so
        // surface it here — at the boundary that's specifically the CLI.
        if (err instanceof DashboardNotReadyError) {
            process.exit(1);
        }

        throw err;
    }
}

// Re-export the imperative interface assembled by `index.ts`.
export type { DashboardApp } from "./types";
