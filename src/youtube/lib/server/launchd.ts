import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { SERVER_BASE_DIR } from "@app/youtube/lib/server/port-file";
import {
    installLaunchd as installAgent,
    isLaunchdInstalled as isAgentInstalled,
    type LaunchdInstallOptions,
    renderLaunchdPlist,
    uninstallLaunchd as uninstallAgent,
} from "@genesiscz/utils/process/launchd-agent";

export const LAUNCHD_LABEL = "com.genesis-tools.youtube-server";

export interface InstallLaunchdOptions {
    port: number;
    bunPath?: string;
    entryPath?: string;
}

export function youtubeLaunchdOptions(opts: Required<InstallLaunchdOptions>): LaunchdInstallOptions {
    return {
        label: LAUNCHD_LABEL,
        command: [opts.bunPath, "run", opts.entryPath, "--port", String(opts.port)],
        cwd: resolve(import.meta.dir, "../../../../.."),
        logPaths: { stdout: join(SERVER_BASE_DIR, "server.log"), stderr: join(SERVER_BASE_DIR, "server.err.log") },
        processType: "Background",
    };
}

export function generateLaunchdPlist(opts: Required<InstallLaunchdOptions>): string {
    return renderLaunchdPlist(youtubeLaunchdOptions(opts));
}

/** Restores the previous plist when the load fails (`installLaunchd` in the shared module). */
export async function installLaunchd(opts: InstallLaunchdOptions): Promise<void> {
    const bunPath = opts.bunPath ?? Bun.which("bun") ?? process.execPath;
    const entryPath = opts.entryPath ?? resolve(import.meta.dir, "index.ts");
    mkdirSync(SERVER_BASE_DIR, { recursive: true });
    // RunAtLoad already started the server on load; a kickstart -k would kill and restart it at once.
    await installAgent(youtubeLaunchdOptions({ port: opts.port, bunPath, entryPath }), { kickstart: false });
}

export async function uninstallLaunchd(): Promise<void> {
    await uninstallAgent(LAUNCHD_LABEL);
}

export function isLaunchdInstalled(): boolean {
    return isAgentInstalled(LAUNCHD_LABEL);
}
