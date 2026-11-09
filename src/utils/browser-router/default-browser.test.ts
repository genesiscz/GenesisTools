import { describe, expect, test } from "bun:test";
import { GENESIS_APP_BUNDLE_ID } from "@genesiscz/utils/macos/genesis-app";
import { type BrowserLookup, type BrowserMeta, resolveDefaultBrowsers } from "./default-browser";
import { defaultRouterConfig, type RouterConfig } from "./route";

const APPS: Record<string, BrowserMeta> = {
    "com.brave.browser": {
        name: "Brave Browser",
        bundleId: "com.brave.Browser",
        appPath: "/Applications/Brave Browser.app",
    },
    "com.apple.safari": { name: "Safari", bundleId: "com.apple.Safari", appPath: "/Applications/Safari.app" },
    [GENESIS_APP_BUNDLE_ID]: {
        name: "GenesisTools",
        bundleId: GENESIS_APP_BUNDLE_ID,
        appPath: "/Users/alice/Applications/GenesisTools.app",
    },
};

/** Looks an app up by bundle id or name, as Launch Services would, from the table above. */
const lookup: BrowserLookup = (target) => {
    if (target.appType === "bundleId") {
        return APPS[target.name.toLowerCase()] ?? null;
    }

    return Object.values(APPS).find((app) => app.name === target.name) ?? null;
};

const routerConfig: RouterConfig = {
    ...defaultRouterConfig({ name: "com.brave.Browser", appType: "bundleId" }),
    routes: [
        {
            pattern: "https://shop\\.example\\.test/.*",
            action: { type: "forward", browser: { name: "Safari", appType: "appName" } },
        },
    ],
};

describe("resolveDefaultBrowsers", () => {
    test("a plain default browser is also the effective one", () => {
        const result = resolveDefaultBrowsers("https://github.com/x/y/issues/1", {
            handler: () => "com.apple.safari",
            config: () => routerConfig,
            lookup,
        });

        expect(result.defaultBrowser?.name).toBe("Safari");
        expect(result.defaultBrowserEffective?.name).toBe("Safari");
        expect(result.viaRouter).toBe(false);
    });

    test("behind the GenesisTools link router, the router's default browser shows an unrouted link", () => {
        const result = resolveDefaultBrowsers("https://github.com/x/y/issues/1", {
            handler: () => GENESIS_APP_BUNDLE_ID,
            config: () => routerConfig,
            lookup,
        });

        expect(result.defaultBrowser?.name).toBe("GenesisTools");
        expect(result.viaRouter).toBe(true);
        expect(result.defaultBrowserEffective).toEqual(APPS["com.brave.browser"]);
    });

    test("a route that forwards to another browser names that browser", () => {
        const result = resolveDefaultBrowsers("https://shop.example.test/cart", {
            handler: () => GENESIS_APP_BUNDLE_ID,
            config: () => routerConfig,
            lookup,
        });

        expect(result.defaultBrowserEffective?.name).toBe("Safari");
    });

    test("a router with no config or no handler at all names no effective browser", () => {
        expect(
            resolveDefaultBrowsers("https://github.com", {
                handler: () => GENESIS_APP_BUNDLE_ID,
                config: () => null,
                lookup,
            }).defaultBrowserEffective
        ).toBeNull();
        const none = resolveDefaultBrowsers("https://github.com", { handler: () => null, config: () => null, lookup });
        expect(none.defaultBrowser).toBeNull();
        expect(none.defaultBrowserEffective).toBeNull();
    });

    test("an app Launch Services does not know keeps its bundle id as its name", () => {
        const result = resolveDefaultBrowsers("https://github.com", {
            handler: () => "org.example.unknown",
            config: () => null,
            lookup,
        });

        expect(result.defaultBrowser).toEqual({
            name: "org.example.unknown",
            bundleId: "org.example.unknown",
            appPath: null,
        });
    });
});
