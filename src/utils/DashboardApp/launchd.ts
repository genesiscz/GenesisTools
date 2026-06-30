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
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { logger } from "@app/logger";

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

/** Resolve bare executable names and inject a launchd-safe PATH (no shell profile). */
export function resolveCommandForLaunchd(
    command: readonly string[],
    cwd?: string
): {
    command: string[];
    env: Record<string, string>;
} {
    const workdir = cwd ?? process.cwd();
    const resolved = [...command];
    const first = resolved[0];

    if (first && !first.includes("/")) {
        const abs = Bun.which(first) ?? (first === "bun" ? process.execPath : undefined);

        if (abs) {
            resolved[0] = abs;
        }
    }

    for (let i = 1; i < resolved.length; i++) {
        const arg = resolved[i];

        if (!arg || arg.startsWith("-") || arg.startsWith("/")) {
            continue;
        }

        if (arg.includes("/")) {
            resolved[i] = resolve(workdir, arg);
        }
    }

    const binDir = dirname(resolved[0] ?? "/usr/bin");
    const env: Record<string, string> = {
        HOME: homedir(),
        PATH: `/usr/local/bin:/opt/homebrew/bin:${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    };

    return { command: resolved, env };
}

export async function bootoutLaunchd(label: string): Promise<void> {
    if (process.platform !== "darwin") {
        return;
    }

    const path = plistPath(label);

    if (!existsSync(path)) {
        return;
    }

    const uid = process.getuid?.();

    if (uid !== undefined) {
        await launchctl(["bootout", `gui/${uid}`, path]).catch(() => undefined);
    }

    await launchctl(["unload", path]).catch(() => undefined);
}

export async function installLaunchd(opts: LaunchdInstallOptions): Promise<void> {
    if (process.platform !== "darwin") {
        throw new Error("Launchd integration is macOS-only.");
    }

    writeLaunchdPlist(opts);

    const path = plistPath(opts.label);

    // Load it. Idempotent: if already loaded, unload first.
    await launchctl(["unload", path]).catch(() => undefined);
    const { exitCode, stderr } = await launchctl(["load", path]);

    if (exitCode !== 0) {
        throw new Error(
            `launchctl load ${path} failed with exit code ${exitCode}${stderr.trim() ? `: ${stderr.trim()}` : ""}`
        );
    }

    await kickstartLaunchd(opts.label);
}

/** Rewrite plist on disk — used when refreshing env/cmd/throttle without full reinstall. */
export function writeLaunchdPlist(opts: LaunchdInstallOptions): void {
    if (process.platform !== "darwin") {
        throw new Error("Launchd integration is macOS-only.");
    }

    const path = plistPath(opts.label);
    const { command: resolvedCommand, env: baseEnv } = resolveCommandForLaunchd(opts.command, opts.cwd);
    const mergedEnv: Record<string, string> = { ...baseEnv };

    for (const [key, value] of Object.entries(opts.env ?? {})) {
        if (value !== undefined) {
            mergedEnv[key] = value;
        }
    }

    const programArgs = resolvedCommand.map((arg) => `        <string>${escapeXml(arg)}</string>`).join("\n");
    const envEntries = Object.entries(mergedEnv)
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
    <integer>2</integer>
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

    mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });
    writeFileSync(path, plist);
}

export async function refreshLaunchd(opts: LaunchdInstallOptions): Promise<void> {
    if (process.platform !== "darwin") {
        throw new Error("Launchd integration is macOS-only.");
    }

    writeLaunchdPlist(opts);

    const path = plistPath(opts.label);
    await launchctl(["load", path]).catch(() => undefined);
    await kickstartLaunchd(opts.label);
}

export async function kickstartLaunchd(label: string): Promise<void> {
    if (process.platform !== "darwin") {
        return;
    }

    const uid = process.getuid?.();

    if (uid === undefined) {
        return;
    }

    await launchctl(["kickstart", "-k", `gui/${uid}/${label}`]).catch((err) =>
        logger.warn({ err, label }, "[launchd] kickstart -k failed; service may not have restarted")
    );
}

/** Load plist if needed and kickstart — faster than rewriting the plist on restart. */
export async function startLaunchd(label: string): Promise<void> {
    if (process.platform !== "darwin") {
        throw new Error("Launchd integration is macOS-only.");
    }

    const path = plistPath(label);

    if (!existsSync(path)) {
        throw new Error(`launchd plist missing: ${path}`);
    }

    const loaded = await launchctl(["load", path]);

    if (loaded.exitCode !== 0) {
        throw new Error(
            `launchctl load ${path} failed with exit code ${loaded.exitCode}${loaded.stderr.trim() ? `: ${loaded.stderr.trim()}` : ""}`
        );
    }

    await kickstartLaunchd(label);
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
