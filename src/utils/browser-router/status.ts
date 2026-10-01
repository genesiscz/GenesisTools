import { GENESIS_APP_BUNDLE_ID, genesisAppBundlePath } from "@genesiscz/utils/macos/genesis-app";
import { type CapabilityCheck, hasCapability, httpsHandler } from "./capabilities";
import { configFile, readRouterConfig } from "./config";
import { type PresetKind, presetDrift, presetRouted, presets } from "./presets";
import type { RouterConfig } from "./route";

export interface PresetStatus {
    id: string;
    title: string;
    kind: PresetKind;
    /** Every capability the preset needs holds on this Mac, and the link host is set if it needs one. */
    available: boolean;
    /** On: a default preset that is available, or an installable one the config switched on. */
    enabled: boolean;
    /** The saved config sends this preset's links to it. */
    routed: boolean;
    /** Saved routes that differ from the preset's current ones; see `presetDrift`. */
    drift: string[];
    /** What keeps the preset from being available. */
    missing: string[];
}

export interface RouterStatus {
    /** GenesisTools.app, which routes the links, exists. */
    installed: boolean;
    /** macOS opens https links with GenesisTools.app, so a link clicked in another app reaches the router. */
    defaultHandler: boolean;
    httpsHandler: string | null;
    appPath: string;
    configPath: string;
    /** A config is saved and parses. */
    configured: boolean;
    /** The host printed links are built on; null means no links are printed. */
    linkHost: string | null;
    /** The browser extension is loaded in a Chromium profile, so typed links reach the router too. */
    extension: boolean;
    presets: PresetStatus[];
    /** Enabled and routed: a link for one of these works on this Mac. */
    enabledPresets: string[];
}

export interface RouterStatusDeps {
    check?: CapabilityCheck;
    config?: RouterConfig | null;
    handler?: string | null;
}

/** Read-only (one `plutil`, the config, each browser profile's preferences): skills call it before printing a link. */
export function routerStatus(deps: RouterStatusDeps = {}): RouterStatus {
    const check = deps.check ?? hasCapability;
    const config = deps.config === undefined ? readRouterConfig() : deps.config;
    const handler = deps.handler === undefined ? httpsHandler() : deps.handler;
    const rows = presets({ config, check }).map(
        (preset): PresetStatus => ({
            id: preset.id,
            title: preset.title,
            kind: preset.kind,
            available: preset.available,
            enabled: preset.enabled,
            routed: config !== null && presetRouted(config, preset),
            drift: config === null ? [] : presetDrift(config, preset),
            missing: preset.missing,
        })
    );

    return {
        installed: check("browser-router:installed"),
        defaultHandler: handler === GENESIS_APP_BUNDLE_ID,
        httpsHandler: handler,
        appPath: genesisAppBundlePath(),
        configPath: configFile(),
        configured: config !== null,
        linkHost: config?.linkHost ?? null,
        extension: check("browser-extension:installed"),
        presets: rows,
        enabledPresets: rows.filter((row) => row.enabled && row.routed).map((row) => row.id),
    };
}
