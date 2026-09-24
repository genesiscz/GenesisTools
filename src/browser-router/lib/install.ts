import { spawnSync } from "node:child_process";
import { buildApp } from "@app/macos/lib/permissions/app";
import { logger } from "@genesiscz/utils/logger";
import { genesisAppBundlePath, genesisAppLauncherPath } from "@genesiscz/utils/macos/genesis-app";
import { ensureBuiltinRoutes } from "./config";

/**
 * Links are routed by GenesisTools.app itself (`Sources/BrowserURL.swift` + the shared `native/Router.swift`).
 * The standalone "Genesis Router.app" is retired: installing it again made it the http(s) handler
 * behind GenesisTools' back (2026-09-24).
 */
export function appBundlePath(): string {
    return genesisAppBundlePath();
}

export async function installRouterApp(): Promise<{ app: string; signedWith: string }> {
    await ensureBuiltinRoutes();
    const built = await buildApp();
    const result = defaultBrowser("set");

    if (result.status !== 0) {
        throw new Error(result.output || "could not become the default browser");
    }

    logger.info(`browser-router: ${built.bundlePath} is the http(s) handler`);
    return { app: built.bundlePath, signedWith: built.signature.authority };
}

export function routerStatus(): string {
    return defaultBrowser("status").output || "app=missing";
}

export function restorePreviousBrowser(): string {
    const result = defaultBrowser("restore");

    if (result.status !== 0) {
        throw new Error(result.output || "could not restore the previous browser");
    }

    return result.output;
}

function defaultBrowser(verb: "set" | "restore" | "status"): { status: number; output: string } {
    const launcher = genesisAppLauncherPath();
    const run = spawnSync(launcher, ["--default-browser", verb], { encoding: "utf8" });

    if (run.error) {
        logger.warn({ error: run.error, launcher }, "browser-router: GenesisTools.app did not start");
        return { status: 1, output: `GenesisTools.app is not installed (${launcher}). Run: bun run app` };
    }

    return { status: run.status ?? 1, output: `${run.stdout}${run.stderr}`.trim() };
}
