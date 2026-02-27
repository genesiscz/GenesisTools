import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const PLIST_PATH = join(homedir(), "Library", "LaunchAgents", "com.genesis-tools.daemon.plist");
const LABEL = "com.genesis-tools.daemon";

export const DAEMON_LOG_DIR = join(homedir(), ".genesis-tools", "daemon", "logs");
export const DAEMON_STDOUT_LOG = join(DAEMON_LOG_DIR, "daemon-stdout.log");
export const DAEMON_STDERR_LOG = join(DAEMON_LOG_DIR, "daemon-stderr.log");

export function generatePlist(): string {
    const home = homedir();
    const daemonScript = resolve(import.meta.dir, "../daemon.ts");
    const logDir = join(home, ".genesis-tools", "daemon", "logs");
    const bunPath = Bun.which("bun") ?? "/usr/local/bin/bun";

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${bunPath}</string><string>run</string><string>${daemonScript}</string></array>
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

export async function installLaunchd(): Promise<void> {
    mkdirSync(join(homedir(), ".genesis-tools", "daemon", "logs"), { recursive: true });
    await Bun.write(PLIST_PATH, generatePlist());
    const proc = Bun.spawn(["launchctl", "load", PLIST_PATH], { stdio: ["ignore", "pipe", "pipe"] });
    const [exitCode, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stderr).text(),
    ]);

    if (exitCode !== 0) {
        throw new Error(`launchctl load failed: ${stderr}`);
    }
}

export async function uninstallLaunchd(): Promise<void> {
    if (existsSync(PLIST_PATH)) {
        await Bun.spawn(["launchctl", "unload", PLIST_PATH], {
            stdio: ["ignore", "pipe", "pipe"],
        }).exited;
        unlinkSync(PLIST_PATH);
    }
}

export async function getDaemonStatus(): Promise<{
    installed: boolean;
    running: boolean;
    pid: number | null;
}> {
    const installed = existsSync(PLIST_PATH);

    if (!installed) {
        return { installed: false, running: false, pid: null };
    }

    const proc = Bun.spawn(["launchctl", "list", LABEL], { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = await new Response(proc.stdout).text();

    if ((await proc.exited) !== 0) {
        return { installed: true, running: false, pid: null };
    }

    const pidMatch = stdout.match(/^(\d+)/m);
    const pid = pidMatch ? parseInt(pidMatch[1], 10) : null;

    return { installed, running: pid != null && pid > 0, pid };
}
