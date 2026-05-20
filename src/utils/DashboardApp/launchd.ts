/**
 * Launchd integration for DashboardApp (macOS only, opt-in).
 *
 * Writes/removes a plist under ~/Library/LaunchAgents and runs `launchctl
 * load|unload` to register the daemon with the per-user launchd. Matches the
 * shape used by `src/youtube/lib/server/launchd.ts` but parameterized.
 *
 * The plist sets `KeepAlive: true` + `RunAtLoad: true` so the daemon survives
 * reboots and respawns on crash. The DashboardApp `down` verb explicitly
 * unloads the plist before SIGTERM so the user's intent to stop isn't
 * defeated by launchd respawning the process immediately.
 */
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LAUNCH_AGENTS_DIR = join(homedir(), "Library", "LaunchAgents");

export function defaultPlistLabel(key: string): string {
    return `com.genesis-tools.${key}`;
}

export function plistPath(label: string): string {
    return join(LAUNCH_AGENTS_DIR, `${label}.plist`);
}

export function isLaunchdInstalled(label: string): boolean {
    if (process.platform !== "darwin") {
        return false;
    }
    return existsSync(plistPath(label));
}

export interface LaunchdInstallOptions {
    label: string;
    command: readonly string[];
    cwd?: string;
    env?: Record<string, string | undefined>;
    logFile: string;
}

export async function installLaunchd(opts: LaunchdInstallOptions): Promise<void> {
    if (process.platform !== "darwin") {
        throw new Error("Launchd integration is macOS-only.");
    }

    const path = plistPath(opts.label);
    const programArgs = opts.command.map((arg) => `        <string>${escapeXml(arg)}</string>`).join("\n");
    const envEntries = Object.entries(opts.env ?? {})
        .filter((entry): entry is [string, string] => entry[1] !== undefined)
        .map(([key, value]) => `        <key>${escapeXml(key)}</key>\n        <string>${escapeXml(value)}</string>`)
        .join("\n");
    const cwdBlock = opts.cwd ? `    <key>WorkingDirectory</key>\n    <string>${escapeXml(opts.cwd)}</string>\n` : "";

    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${escapeXml(opts.label)}</string>
    <key>ProgramArguments</key>
    <array>
${programArgs}
    </array>
${cwdBlock}    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>${escapeXml(opts.logFile)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(opts.logFile)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${envEntries}
    </dict>
</dict>
</plist>
`;

    writeFileSync(path, plist);

    // Load it. Idempotent: if already loaded, unload first.
    await launchctl(["unload", path]).catch(() => undefined);
    const { exitCode } = await launchctl(["load", path]);
    if (exitCode !== 0) {
        throw new Error(`launchctl load ${path} failed with exit code ${exitCode}`);
    }
}

export async function uninstallLaunchd(label: string): Promise<void> {
    if (process.platform !== "darwin") {
        return;
    }

    const path = plistPath(label);
    if (existsSync(path)) {
        await launchctl(["unload", path]).catch(() => undefined);
        unlinkSync(path);
    }
}

async function launchctl(args: readonly string[]): Promise<{ exitCode: number; stderr: string }> {
    const proc = Bun.spawn(["launchctl", ...args], { stdout: "pipe", stderr: "pipe" });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { exitCode, stderr };
}

function escapeXml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
