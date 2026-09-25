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
    // The app first: a preset such as cmux-claude needs `browser-router:installed` before its route is written.
    const built = await buildApp();
    await ensureBuiltinRoutes();
    const result = defaultBrowser("set");

    if (result.status !== 0) {
        throw new Error(result.output || "could not become the default browser");
    }

    logger.info(`browser-router: ${built.bundlePath} is the http(s) handler`);
    return { app: built.bundlePath, signedWith: built.signature.authority };
}

/** The app's own report (`GenesisTools --default-browser status`); slower than `routerStatus()`, it starts the app. */
export function defaultBrowserStatus(): string {
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
        // Expected before the first build; the returned line says so, so the stack stays in the log file.
        logger.debug({ error: run.error, launcher }, "browser-router: GenesisTools.app did not start");
        return { status: 1, output: `GenesisTools.app is not installed (${launcher}). Run: bun run app` };
    }

    return { status: run.status ?? 1, output: `${run.stdout}${run.stderr}`.trim() };
}
