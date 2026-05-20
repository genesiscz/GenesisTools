/**
 * DashboardApp lifecycle orchestration — the `up` / `down` / `restart` /
 * `status` / `attach` / `logs` / `install` / `uninstall` operations.
 *
 * Each operation is a free function so it can be tested in isolation against
 * a synthetic DashboardApp instance. `commander.ts` wires verbs to these
 * functions; the imperative `DashboardApp` API on `types.ts` does the same.
 */
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import logger from "@app/logger";
import { Browser } from "@app/utils/browser";
import { suggestCommand } from "@app/utils/cli";
import { isPortInUse } from "@app/utils/network";
import { spawnDashboard } from "@app/utils/process/spawnDashboard";
import { stripAnsi } from "@app/utils/string";
import { spawnDetached } from "./detach";
import { defaultPlistLabel, installLaunchd, isLaunchdInstalled, uninstallLaunchd } from "./launchd";
import {
    describeConflict,
    promptDependencyStart,
    promptForeignMenu,
    promptLaunchdInstall,
    promptMineMenu,
} from "./menu";
import { clearPid, ensureLogFile, logFilePath, pidFilePath, pidFileStartTime, readPid, writePid } from "./pidFile";
import { checkPortConflict } from "./portConflict";
import { readPreferences, writePreferences } from "./preferences";
import { waitForReady } from "./readiness";
import type {
    DashboardAppConfig,
    DependencyStatus,
    DownOptions,
    DownResult,
    PreflightWarning,
    StatusResult,
    UpOptions,
    UpResult,
} from "./types";

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

export async function up(ctx: LifecycleContext, opts: UpOptions = {}): Promise<UpResult> {
    const { config } = ctx;
    const port = opts.port ?? ctx.port;

    // 1. Preflight (soft warnings only — never blocks the up).
    if (config.preflight) {
        try {
            const { warnings } = await config.preflight();
            for (const w of warnings) {
                logger.warn({ service: w.service, fix: w.fix }, w.error);
                process.stderr.write(`⚠ ${w.service}: ${w.error}${w.fix ? `\n  Fix: ${w.fix}` : ""}\n`);
            }
        } catch (err) {
            logger.warn({ err }, `[${config.key}] preflight threw`);
        }
    }

    // 2. Resolve dependencies. Each dep gets its own up if policy says so.
    for (const dep of config.dependencies ?? []) {
        const depStatus = await dep.app.status();
        if (depStatus.running) {
            continue;
        }

        if (dep.policy === "auto") {
            process.stderr.write(`→ starting dependency ${dep.app.config.key}...\n`);
            await dep.app.up({ open: false });
            continue;
        }

        if (dep.policy === "warn") {
            process.stderr.write(`⚠ dependency ${dep.app.config.key} is not running.\n`);
            continue;
        }

        // prompt
        const choice = await promptDependencyStart(dep.app.config.key, config.key);
        if (choice === "start") {
            await dep.app.up({ open: false });
        } else if (choice === null) {
            process.stderr.write(
                `⚠ dependency ${dep.app.config.key} is not running. Run \`tools ${dep.app.config.key} ${dep.app.config.commandName} up\` to start it.\n`
            );
        }
    }

    // 3. Port conflict check.
    const conflict = await checkPortConflict(config.key, port);
    logger.debug({ conflict: describeConflict(conflict) }, `[${config.key}] port conflict check`);

    if (conflict.state === "mine") {
        if (opts.interactive) {
            return handleMineMenu(ctx, conflict.pid, opts);
        }
        return handleMineMenu(ctx, conflict.pid, opts);
    }

    if (conflict.state === "foreign") {
        if (opts.force && conflict.owner) {
            process.stderr.write(`→ killing port owner pid ${conflict.owner.pid} (${conflict.owner.command})\n`);
            try {
                process.kill(conflict.owner.pid, "SIGTERM");
            } catch (err) {
                logger.warn({ err, pid: conflict.owner.pid }, `[${config.key}] failed to kill foreign owner`);
            }
            await waitForPortFree(port, 5_000);
        } else {
            const owner = conflict.owner;
            const ownerDesc = owner ? `pid ${owner.pid} (${owner.command})` : "(unknown owner)";
            process.stderr.write(`✗ port ${port} is held by ${ownerDesc}.\n`);

            if (owner) {
                const choice = await promptForeignMenu(port, owner.pid, owner.command, owner.sameUser);
                if (choice === "kill-and-up") {
                    try {
                        process.kill(owner.pid, "SIGTERM");
                    } catch (err) {
                        logger.warn({ err, pid: owner.pid }, `[${config.key}] failed to kill foreign owner`);
                    }
                    await waitForPortFree(port, 5_000);
                } else if (choice === null) {
                    process.stderr.write(
                        `  Use --force to kill the owner and start: ${suggestCommand("tools", { add: ["--force"] })}\n`
                    );
                    return { started: false, port, mode: opts.foreground ? "foreground" : "background" };
                } else {
                    return { started: false, port, mode: opts.foreground ? "foreground" : "background" };
                }
            } else {
                return { started: false, port, mode: opts.foreground ? "foreground" : "background" };
            }
        }
    }

    // 4. Launchd first-run prompt (TTY only, opt-in apps only).
    if (
        config.launchd?.available &&
        !opts.skipInstallPrompt &&
        !readPreferences(config.key).launchdInstalled &&
        !readPreferences(config.key).launchdPromptDismissed
    ) {
        const wantInstall = await promptLaunchdInstall(config.key);
        if (wantInstall === true) {
            await install(ctx);
            // Launchd will start the process via the plist. Return now — readiness wait below.
            const ok = await waitForReady(config.readiness, { port, logFile: ctx.logFile });
            return {
                started: ok.ready,
                port,
                mode: "background",
                pid: readPid(config.key) ?? undefined,
                logPath: ctx.logFile,
            };
        }
        if (wantInstall === false) {
            writePreferences(config.key, { launchdPromptDismissed: true });
        }
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
                env: config.spawn.env,
            });
            clearPid(config.key);
            process.exit(exitCode);
        } catch (err) {
            clearPid(config.key);
            throw err;
        }
    }

    // Background: detached spawn with stdio → logfile.
    ensureLogFile(config.key);
    const { pid } = spawnDetached({
        cmd: [...config.spawn.cmd],
        cwd: config.spawn.cwd,
        env: config.spawn.env,
        logFile: ctx.logFile,
    });
    writePid(config.key, pid);

    const readiness = await waitForReady(config.readiness, { port, logFile: ctx.logFile });
    if (!readiness.ready) {
        process.stderr.write(
            `⚠ readiness check failed: ${readiness.detail ?? "(no detail)"}\n  Started anyway — tail the log: tools ${config.key} ${config.commandName} attach\n`
        );
    } else {
        process.stderr.write(
            `✓ ${config.name ?? config.key} ready on http://localhost:${port}  (pid ${pid})\n  logs → ${ctx.logFile}\n`
        );
    }

    // Browser-open (UI only).
    if (config.type === "ui" && (opts.open ?? config.openBrowser?.enabled)) {
        const browserUrl = config.openBrowser?.url ? config.openBrowser.url(port) : `http://localhost:${port}`;
        await Browser.open(browserUrl).catch((err) => {
            logger.warn({ err }, `[${config.key}] browser open failed`);
        });
    }

    return { started: true, port, mode, pid, logPath: ctx.logFile };
}

async function handleMineMenu(ctx: LifecycleContext, pid: number, opts: UpOptions): Promise<UpResult> {
    const { config, port } = ctx;
    const choice = await promptMineMenu(port, pid);

    if (choice === null) {
        // Non-TTY: print the verbs and exit.
        process.stderr.write(
            `Already running (pid ${pid} on :${port}). Try one of:\n` +
                `  tools <tool> ${config.commandName} restart\n` +
                `  tools <tool> ${config.commandName} attach\n` +
                `  tools <tool> ${config.commandName} status\n` +
                `  tools <tool> ${config.commandName} down\n`
        );
        return { started: false, port, mode: opts.foreground ? "foreground" : "background" };
    }

    if (choice === "restart") {
        await down(ctx, {});
        return up(ctx, { ...opts, interactive: false });
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
    return { started: false, port, mode: "background" };
}

export async function down(ctx: LifecycleContext, opts: DownOptions = {}): Promise<DownResult> {
    const { config } = ctx;
    const pid = readPid(config.key);
    if (!pid) {
        process.stderr.write(`${config.name ?? config.key} is not running.\n`);
        clearPid(config.key); // clean up stale PID file if any
        return { stopped: false };
    }

    // If launchd-managed, unload first so it doesn't respawn.
    if (config.launchd?.available && isLaunchdInstalled(ctx.plistLabel)) {
        await uninstallLaunchd(ctx.plistLabel).catch((err) => {
            logger.warn({ err }, `[${config.key}] launchd unload failed`);
        });
    }

    try {
        process.kill(pid, "SIGTERM");
    } catch (err) {
        logger.warn({ err, pid }, `[${config.key}] SIGTERM failed`);
    }

    const force = opts.force ?? true;
    const gracePeriodMs = 5_000;
    const deadline = Date.now() + gracePeriodMs;
    while (Date.now() < deadline) {
        if (!isProcessAlive(pid)) {
            clearPid(config.key);
            process.stderr.write(`✓ ${config.name ?? config.key} stopped (pid ${pid})\n`);
            return { stopped: true, pid };
        }
        await Bun.sleep(200);
    }

    if (force) {
        try {
            process.kill(pid, "SIGKILL");
        } catch (err) {
            logger.warn({ err, pid }, `[${config.key}] SIGKILL failed`);
        }
        // brief wait for kernel to clean up
        await Bun.sleep(500);
    }

    if (!isProcessAlive(pid)) {
        clearPid(config.key);
        process.stderr.write(`✓ ${config.name ?? config.key} stopped (pid ${pid}, forced)\n`);
        return { stopped: true, pid };
    }

    process.stderr.write(`✗ failed to stop pid ${pid}; it may need manual cleanup.\n`);
    return { stopped: false, pid };
}

export async function restart(ctx: LifecycleContext, opts: UpOptions = {}): Promise<UpResult> {
    await down(ctx, {});
    return up(ctx, opts);
}

export async function status(ctx: LifecycleContext): Promise<StatusResult> {
    const { config, port } = ctx;
    const pid = readPid(config.key);
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
        running: pid !== null,
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
    process.stdout.write(`${lines.join("\n")}\n`);
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
        process.stderr.write(`No log file at ${logFile} — nothing to attach to.\n`);
        return;
    }

    // Print the tail first.
    await logs(ctx, { lines: opts.lines ?? 50 });

    process.stderr.write(`\n--- attached (Ctrl+C to detach the tail; the process keeps running) ---\n`);

    let pos = statSync(logFile).size;
    const isTty = Boolean(process.stdout.isTTY);

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
                process.stdout.write(isTty ? chunk : stripAnsi(chunk));
            } finally {
                closeSync(fd);
            }
        }
    } finally {
        process.off("SIGINT", handler);
    }
}

export async function logs(ctx: LifecycleContext, opts: { lines?: number } = {}): Promise<void> {
    const { logFile } = ctx;
    if (!existsSync(logFile)) {
        process.stderr.write(`No log file at ${logFile}.\n`);
        return;
    }

    const requested = opts.lines ?? 200;
    const size = statSync(logFile).size;
    const readBytes = Math.min(size, Math.max(8_192, requested * 200));
    const fd = openSync(logFile, "r");
    try {
        const buf = Buffer.alloc(readBytes);
        const read = readSync(fd, buf, 0, readBytes, Math.max(0, size - readBytes));
        const text = buf.subarray(0, read).toString();
        const allLines = text.split("\n");
        const tail = allLines.slice(-requested).join("\n");
        const isTty = Boolean(process.stdout.isTTY);
        process.stdout.write(isTty ? tail : stripAnsi(tail));
        if (!tail.endsWith("\n")) {
            process.stdout.write("\n");
        }
    } finally {
        closeSync(fd);
    }
}

export async function install(ctx: LifecycleContext): Promise<void> {
    if (!ctx.config.launchd?.available) {
        throw new Error(`${ctx.config.key} does not opt into launchd integration.`);
    }
    if (process.platform !== "darwin") {
        throw new Error("Launchd integration is macOS-only.");
    }

    ensureLogFile(ctx.config.key);
    await installLaunchd({
        label: ctx.plistLabel,
        command: ctx.config.spawn.cmd,
        cwd: ctx.config.spawn.cwd,
        env: ctx.config.spawn.env,
        logFile: ctx.logFile,
    });
    writePreferences(ctx.config.key, { launchdInstalled: true, launchdPromptDismissed: false });
    process.stderr.write(`✓ launchd plist installed at ~/Library/LaunchAgents/${ctx.plistLabel}.plist\n`);
}

export async function uninstall(ctx: LifecycleContext): Promise<void> {
    await uninstallLaunchd(ctx.plistLabel);
    writePreferences(ctx.config.key, { launchdInstalled: false });
    process.stderr.write(`✓ launchd plist removed.\n`);
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function waitForPortFree(port: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!(await isPortInUse(port))) {
            return;
        }
        await Bun.sleep(150);
    }
}

// Re-export the imperative interface assembled by `index.ts`.
export type { DashboardApp } from "./types";
