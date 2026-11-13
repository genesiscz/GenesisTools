import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { launchdPlistNeedsGenesisApp } from "@genesiscz/utils/macos/genesis-app";
import {
    installLaunchd as installAgent,
    type LaunchdInstallOptions,
    launchdStatus,
    plistPath,
    renderLaunchdPlist,
    uninstallLaunchd as uninstallAgent,
} from "@genesiscz/utils/process/launchd-agent";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";

const LABEL = "com.genesis-tools.daemon";

export const DAEMON_LOG_DIR = genesisToolsDir("daemon", "logs");
export const DAEMON_STDERR_LOG = join(DAEMON_LOG_DIR, "daemon-stderr.log");

/** The launchd job. `ProcessType` is `Standard`: the daemon and a normal-priority task run unthrottled, and a heavy
 *  task asks for background QoS itself with `priority: "low"` (runner `taskArgv`). As `Background`, every task was
 *  throttled: a 0.2 s dry run took 125.6 s once at load average 35 (2026-10-12).
 *  Both streams go to `daemon-stderr.log` on purpose (commit 7c178b7fc5): one file holds the whole run. */
export function daemonLaunchdOptions(): LaunchdInstallOptions {
    const bunPath = Bun.which("bun") ?? "/usr/local/bin/bun";

    return {
        label: LABEL,
        command: [bunPath, "run", resolve(import.meta.dir, "../daemon.ts")],
        cwd: homedir(),
        logFile: DAEMON_STDERR_LOG,
        processType: "Standard",
    };
}

export function generatePlist(): string {
    return renderLaunchdPlist(daemonLaunchdOptions());
}

/**
 * Idempotent, and restores the previous plist when the load fails (`installLaunchd` in the shared
 * module), so a failed migration never leaves the user with no agent at all.
 */
export async function installLaunchd(): Promise<void> {
    mkdirSync(DAEMON_LOG_DIR, { recursive: true });
    // RunAtLoad already started the daemon on load; a kickstart -k would kill and restart it at once.
    await installAgent(daemonLaunchdOptions(), { kickstart: false });
}

export async function uninstallLaunchd(): Promise<void> {
    await uninstallAgent(LABEL);
}

export async function getDaemonStatus(): Promise<{
    installed: boolean;
    running: boolean;
    pid: number | null;
    /** plist predates GenesisTools.app; `tools daemon restart` or `install` migrates it */
    needsMigration: boolean;
}> {
    const path = plistPath(LABEL);
    const installed = existsSync(path);
    const needsMigration = launchdPlistNeedsGenesisApp(path);

    if (!installed) {
        return { installed: false, running: false, pid: null, needsMigration };
    }

    const { pid } = await launchdStatus(LABEL);
    return { installed, running: pid !== undefined, pid: pid ?? null, needsMigration };
}
