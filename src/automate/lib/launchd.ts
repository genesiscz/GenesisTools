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

const LABEL = "com.genesis-tools.automate";

export const DAEMON_LOG_DIR = genesisToolsDir("automate", "logs");
export const DAEMON_STDOUT_LOG = join(DAEMON_LOG_DIR, "daemon-stdout.log");
export const DAEMON_STDERR_LOG = join(DAEMON_LOG_DIR, "daemon-stderr.log");

export function automateLaunchdOptions(): LaunchdInstallOptions {
    const bunPath = Bun.which("bun") ?? "/usr/local/bin/bun";

    return {
        label: LABEL,
        command: [bunPath, "run", resolve(import.meta.dir, "daemon.ts")],
        cwd: homedir(),
        logPaths: { stdout: DAEMON_STDOUT_LOG, stderr: DAEMON_STDERR_LOG },
        processType: "Background",
    };
}

export function generatePlist(): string {
    return renderLaunchdPlist(automateLaunchdOptions());
}

/**
 * Idempotent, and restores the previous plist when the load fails (`installLaunchd` in the shared
 * module), so a failed migration never leaves the user with no agent at all.
 */
export async function installLaunchd(): Promise<void> {
    mkdirSync(DAEMON_LOG_DIR, { recursive: true });
    // RunAtLoad already started the scheduler on load; a kickstart -k would kill and restart it at once.
    await installAgent(automateLaunchdOptions(), { kickstart: false });
}

export async function uninstallLaunchd(): Promise<void> {
    await uninstallAgent(LABEL);
}

export async function getDaemonStatus(): Promise<{
    installed: boolean;
    running: boolean;
    pid: number | null;
    /** plist predates GenesisTools.app; `tools automate daemon install` migrates it */
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
