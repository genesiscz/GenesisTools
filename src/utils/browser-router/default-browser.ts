import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { GENESIS_APP_BUNDLE_ID } from "@genesiscz/utils/macos/genesis-app";
import { appPathForBundleId } from "@genesiscz/utils/macos/launch-services";
import { httpsHandler } from "./capabilities";
import { readRouterConfig } from "./config";
import { type AppType, BROWSER_ROUTER_BUNDLE_ID, type RouterConfig, route } from "./route";

/** An app that can show a link: the name a button says ("Open in Brave Browser"), its bundle id and where it is. */
export interface BrowserMeta {
    name: string;
    bundleId: string | null;
    appPath: string | null;
}

/** Which browser a click on a link reaches. */
export interface DefaultBrowsers {
    url: string;
    /** The app macOS gives https links to (System Settings → Desktop & Dock → Default web browser). */
    defaultBrowser: BrowserMeta | null;
    /**
     * The browser that really shows `url`: the default browser itself, or, when that is GenesisTools' link router,
     * the browser its routes pick for this URL. Null when the router runs a command for it or has no config.
     */
    defaultBrowserEffective: BrowserMeta | null;
    /** The default browser is GenesisTools' link router. */
    viaRouter: boolean;
}

/** Finds an app by the way a router config names it: a bundle id, an app name or a path. */
export type BrowserLookup = (target: { name: string; appType: AppType }) => BrowserMeta | null;

export interface DefaultBrowserDeps {
    /** The https handler's bundle id (`httpsHandler()`). */
    handler?: () => string | null;
    /** The link router's config (`readRouterConfig()`). */
    config?: () => RouterConfig | null;
    lookup?: BrowserLookup;
}

const ROUTER_IDS = new Set([GENESIS_APP_BUNDLE_ID.toLowerCase(), BROWSER_ROUTER_BUNDLE_ID.toLowerCase()]);

/**
 * The default browser and the browser a click on `url` really reaches. Behind GenesisTools' link router this applies
 * the router's own `route()` to the URL (no token is spent), so "Open in Brave" is what the click does.
 */
export function resolveDefaultBrowsers(url: string, deps: DefaultBrowserDeps = {}): DefaultBrowsers {
    const lookup = deps.lookup ?? lookupBrowser;
    const handlerId = (deps.handler ?? httpsHandler)();
    const defaultBrowser = handlerId ? (lookup({ name: handlerId, appType: "bundleId" }) ?? bare(handlerId)) : null;
    const viaRouter = handlerId !== null && ROUTER_IDS.has(handlerId.toLowerCase());

    if (!viaRouter) {
        return { url, defaultBrowser, defaultBrowserEffective: defaultBrowser, viaRouter };
    }

    const config = (deps.config ?? readRouterConfig)();
    if (!config) {
        logger.debug({ url }, "default-browser: the link router is the default browser but has no config");
        return { url, defaultBrowser, defaultBrowserEffective: null, viaRouter };
    }

    try {
        const decision = route(url, config);

        if (
            (decision.kind === "open" || decision.kind === "forward") &&
            decision.browser &&
            decision.browser.appType !== "none"
        ) {
            const target = { name: decision.browser.name, appType: decision.browser.appType };
            return { url, defaultBrowser, defaultBrowserEffective: lookup(target) ?? bare(target.name), viaRouter };
        }

        logger.debug({ url, kind: decision.kind }, "default-browser: the router does not show this link in a browser");
        return { url, defaultBrowser, defaultBrowserEffective: null, viaRouter };
    } catch (error) {
        logger.debug({ error, url }, "default-browser: the router refused the link");
        return { url, defaultBrowser, defaultBrowserEffective: null, viaRouter };
    }
}

/** An app Launch Services does not know: its id or name stands in for everything. */
function bare(name: string): BrowserMeta {
    return { name, bundleId: name.includes(".") && !name.includes("/") ? name : null, appPath: null };
}

/** The real lookup: Launch Services for a bundle id, the app folders for a name, the bundle's Info.plist for both. */
export const lookupBrowser: BrowserLookup = (target) => {
    let appPath: string | null = null;

    if (target.appType === "bundleId") {
        appPath = appPathForBundleId(target.name);
    } else if (target.appType === "path") {
        appPath = existsSync(target.name) ? target.name : null;
    } else if (target.appType === "appName") {
        const file = target.name.endsWith(".app") ? target.name : `${target.name}.app`;
        appPath =
            ["/Applications", "/System/Applications", "/System/Volumes/Preboot/Cryptexes/App/System/Applications"]
                .map((folder) => join(folder, file))
                .find((path) => existsSync(path)) ?? null;
    }

    if (!appPath) {
        return null;
    }

    const plist = join(appPath, "Contents/Info.plist");
    const name =
        plistString(plist, "CFBundleDisplayName") ?? plistString(plist, "CFBundleName") ?? basename(appPath, ".app");
    return { name, bundleId: plistString(plist, "CFBundleIdentifier"), appPath };
};

function plistString(plist: string, key: string): string | null {
    if (process.platform !== "darwin" || !existsSync(plist)) {
        return null;
    }

    const run = Bun.spawnSync(["plutil", "-extract", key, "raw", "-o", "-", plist], {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 2_000,
    });

    if (run.exitCode !== 0) {
        logger.debug(
            { plist, key, exitCode: run.exitCode, stderr: run.stderr.toString().trim() },
            "default-browser: plutil could not read the key"
        );
        return null;
    }

    const value = run.stdout.toString().trim();
    return value.length > 0 ? value : null;
}
