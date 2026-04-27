import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { SERVER_BASE_DIR } from "@app/youtube/lib/server/port-file";

const LAUNCH_AGENTS_DIR = join(homedir(), "Library", "LaunchAgents");
export const LAUNCHD_LABEL = "com.genesis-tools.youtube-server";
export const PLIST_PATH = join(LAUNCH_AGENTS_DIR, `${LAUNCHD_LABEL}.plist`);

export interface InstallLaunchdOptions {
    port: number;
    bunPath?: string;
    entryPath?: string;
}

export function generateLaunchdPlist(opts: Required<InstallLaunchdOptions>): string {
    const logPath = join(SERVER_BASE_DIR, "server.log");
    const errorLogPath = join(SERVER_BASE_DIR, "server.err.log");

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${opts.bunPath}</string>
    <string>run</string>
    <string>${opts.entryPath}</string>
    <string>--port</string><string>${opts.port}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${logPath}</string>
  <key>StandardErrorPath</key><string>${errorLogPath}</string>
  <key>EnvironmentVariables</key>
  <dict><key>HOME</key><string>${homedir()}</string><key>PATH</key><string>/usr/local/bin:/usr/bin:/bin:${dirname(opts.bunPath)}</string></dict>
  <key>WorkingDirectory</key><string>${resolve(import.meta.dir, "../../../../..")}</string>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>`;
}

export async function installLaunchd(opts: InstallLaunchdOptions): Promise<void> {
    const bunPath = opts.bunPath ?? Bun.which("bun") ?? process.execPath;
    const entryPath = opts.entryPath ?? resolve(import.meta.dir, "index.ts");
    mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });
    mkdirSync(SERVER_BASE_DIR, { recursive: true });
    await Bun.write(PLIST_PATH, generateLaunchdPlist({ port: opts.port, bunPath, entryPath }));
    const proc = Bun.spawn(["launchctl", "load", "-w", PLIST_PATH], { stdio: ["ignore", "pipe", "pipe"] });
    const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);

    if (exitCode !== 0) {
        throw new Error(`launchctl load failed: ${stderr}`);
    }
}

export async function uninstallLaunchd(): Promise<void> {
    if (!existsSync(PLIST_PATH)) {
        return;
    }

    await Bun.spawn(["launchctl", "unload", PLIST_PATH], { stdio: ["ignore", "pipe", "pipe"] }).exited;
    unlinkSync(PLIST_PATH);
}

export function isLaunchdInstalled(): boolean {
    return existsSync(PLIST_PATH);
}
