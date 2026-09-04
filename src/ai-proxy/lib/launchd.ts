/**
 * Launchd agent for ai-proxy (macOS only, opt-in).
 *
 * Route decision (2026-08-31): reuse the generic plist writer in
 * `@genesiscz/utils/DashboardApp/launchd` rather than copy
 * `src/youtube/lib/server/launchd.ts`. ai-proxy does NOT adopt the whole
 * `DashboardApp/lifecycle` path, because ai-proxy's `up` also owns the shared
 * cloudflared exposure tunnel and its `down` must never stop it — an invariant
 * the generic lifecycle knows nothing about. So this module owns the label and
 * the plist inputs, and `lib/lifecycle.ts` keeps owning the tunnel.
 *
 * The plist carries HOME/PATH/LANG/LC_* and NO API keys: the proxy reads Grok
 * OAuth from `~/.grok/auth.json` (hence HOME) and every other credential from
 * `~/.genesis-tools/ai-proxy/config.json` and the encrypted vault.
 */
import { join } from "node:path";
import { getAiProxyStorage } from "@app/ai-proxy/lib/storage";
import {
    bootoutLaunchd,
    defaultPlistLabel,
    installLaunchd,
    isLaunchdInstalled,
    type LaunchdInstallOptions,
    plistPath,
    startLaunchd,
    uninstallLaunchd,
} from "@genesiscz/utils/DashboardApp/launchd";

export const AI_PROXY_LAUNCHD_LABEL = defaultPlistLabel("ai-proxy");

export function proxyEntryPath(): string {
    return join(import.meta.dir, "..", "index.ts");
}

export function toolsRoot(): string {
    return join(import.meta.dir, "..", "..", "..");
}

export function aiProxyPlistPath(): string {
    return plistPath(AI_PROXY_LAUNCHD_LABEL);
}

export function isAiProxyLaunchdInstalled(): boolean {
    return isLaunchdInstalled(AI_PROXY_LAUNCHD_LABEL);
}

export function buildAiProxyLaunchdOptions(port: number): LaunchdInstallOptions {
    return {
        label: AI_PROXY_LAUNCHD_LABEL,
        command: ["bun", "run", proxyEntryPath(), "serve", "--port", String(port)],
        cwd: toolsRoot(),
        // HOME and a launchd-safe PATH come from resolveCommandForLaunchd. These
        // three only fix the encoding: a launchd agent inherits no shell profile,
        // so without them the proxy runs under the C locale.
        env: {
            LANG: "en_US.UTF-8",
            LC_ALL: "en_US.UTF-8",
            LC_CTYPE: "en_US.UTF-8",
        },
        logFile: getAiProxyStorage().proxyLogPath(),
    };
}

export async function installAiProxyLaunchd(port: number): Promise<string> {
    await getAiProxyStorage().ensureDirs();
    await installLaunchd(buildAiProxyLaunchdOptions(port));
    return aiProxyPlistPath();
}

export async function uninstallAiProxyLaunchd(): Promise<boolean> {
    if (!isAiProxyLaunchdInstalled()) {
        return false;
    }

    await bootoutLaunchd(AI_PROXY_LAUNCHD_LABEL);
    await uninstallLaunchd(AI_PROXY_LAUNCHD_LABEL);
    return true;
}

/** Load (if needed) and kickstart the agent. Used by `up` on the launchd path. */
export async function startAiProxyLaunchd(): Promise<void> {
    await startLaunchd(AI_PROXY_LAUNCHD_LABEL);
}

/**
 * Unload the agent so `KeepAlive` cannot answer our SIGTERM with a respawn.
 * `down` calls this BEFORE it signals anything.
 */
export async function stopAiProxyLaunchd(): Promise<void> {
    await bootoutLaunchd(AI_PROXY_LAUNCHD_LABEL);
}
