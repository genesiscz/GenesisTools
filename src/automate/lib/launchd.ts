import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import { launchdPlistNeedsGenesisApp, launchdProgramArgumentsXml } from "@genesiscz/utils/macos/genesis-app";

const PLIST_PATH = join(homedir(), "Library", "LaunchAgents", "com.genesis-tools.automate.plist");
const LABEL = "com.genesis-tools.automate";

export const DAEMON_LOG_DIR = join(env.tools.getHome(), ".genesis-tools", "automate", "logs");
export const DAEMON_STDOUT_LOG = join(DAEMON_LOG_DIR, "daemon-stdout.log");
export const DAEMON_STDERR_LOG = join(DAEMON_LOG_DIR, "daemon-stderr.log");

export function generatePlist(): string {
    const home = homedir();
    const daemonScript = resolve(import.meta.dir, "daemon.ts");
    const logDir = join(home, ".genesis-tools", "automate", "logs");
    const bunPath = Bun.which("bun") ?? "/usr/local/bin/bun";

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
${launchdProgramArgumentsXml([bunPath, "run", daemonScript])}
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${logDir}/daemon-stdout.log</string>
  <key>StandardErrorPath</key><string>${logDir}/daemon-stderr.log</string>
  <key>EnvironmentVariables</key>
  <dict><key>HOME</key><string>${home}</string><key>PATH</key><string>/usr/local/bin:/usr/bin:/bin:${dirname(bunPath)}</string></dict>
  <key>WorkingDirectory</key><string>${home}</string>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>`;
}

/**
 * Idempotent: a loaded job is unloaded first, so re-running install (for example to migrate)
 * reloads the new plist. The previous plist is kept in memory and restored if anything after the
 * unload fails, so a failed migration never leaves the user with no agent at all.
 */
export async function installLaunchd(): Promise<void> {
    mkdirSync(join(env.tools.getHome(), ".genesis-tools", "automate", "logs"), { recursive: true });

    const previousPlist = existsSync(PLIST_PATH) ? readFileSync(PLIST_PATH, "utf8") : undefined;

    if (previousPlist !== undefined) {
        await Bun.spawn(["launchctl", "unload", PLIST_PATH], { stdio: ["ignore", "pipe", "pipe"] }).exited;
    }

    try {
        await Bun.write(PLIST_PATH, generatePlist());
        const proc = Bun.spawn(["launchctl", "load", PLIST_PATH], { stdio: ["ignore", "pipe", "pipe"] });
        const exitCode = await proc.exited;
        if (exitCode !== 0) {
            throw new Error(`launchctl load failed: ${await new Response(proc.stderr).text()}`);
        }
    } catch (error) {
        await restorePreviousPlist(previousPlist, error);
        throw error;
    }
}

/**
 * Put the old plist back and reload it; a restore failure must not mask the original error.
 * `launchctl load` reports failure through its exit code, not by rejecting, so claiming recovery
 * without reading that code would announce a running agent that is in fact still unloaded.
 */
async function restorePreviousPlist(previousPlist: string | undefined, cause: unknown): Promise<void> {
    if (previousPlist === undefined) {
        return;
    }

    try {
        await Bun.write(PLIST_PATH, previousPlist);
        const proc = Bun.spawn(["launchctl", "load", PLIST_PATH], { stdio: ["ignore", "pipe", "pipe"] });
        const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);

        if (exitCode !== 0) {
            logger.error(
                { cause, plist: PLIST_PATH, exitCode, stderr: stderr.trim() },
                "launchd install failed; the previous plist was written back but launchctl load failed, so no agent is loaded"
            );
            return;
        }

        logger.warn({ err: cause, plist: PLIST_PATH }, "launchd install failed; previous plist restored and reloaded");
    } catch (restoreError) {
        logger.error(
            { err: restoreError, cause, plist: PLIST_PATH },
            "launchd install failed AND the previous plist could not be restored"
        );
    }
}

export async function uninstallLaunchd(): Promise<void> {
    if (existsSync(PLIST_PATH)) {
        await Bun.spawn(["launchctl", "unload", PLIST_PATH], { stdio: ["ignore", "pipe", "pipe"] }).exited;
        unlinkSync(PLIST_PATH);
    }
}

export async function getDaemonStatus(): Promise<{
    installed: boolean;
    running: boolean;
    pid: number | null;
    /** plist predates GenesisTools.app; `tools automate daemon install` migrates it */
    needsMigration: boolean;
}> {
    const installed = existsSync(PLIST_PATH);
    const needsMigration = launchdPlistNeedsGenesisApp(PLIST_PATH);
    if (!installed) {
        return { installed: false, running: false, pid: null, needsMigration };
    }
    const proc = Bun.spawn(["launchctl", "list", LABEL], { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) {
        return { installed: true, running: false, pid: null, needsMigration };
    }
    const pidMatch = stdout.match(/^(\d+)/m);
    const pid = pidMatch ? parseInt(pidMatch[1], 10) : null;
    return { installed, running: pid != null && pid > 0, pid, needsMigration };
}
