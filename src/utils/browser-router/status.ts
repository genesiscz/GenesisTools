import { GENESIS_APP_BUNDLE_ID, genesisAppBundlePath } from "@genesiscz/utils/macos/genesis-app";
import { type Capability, type CapabilityCheck, hasCapability, httpsHandler } from "./capabilities";
import { configFile, readRouterConfig } from "./config";
import { presetDrift, presetRouted, presets } from "./presets";
import type { RouterConfig } from "./route";

export interface PresetStatus {
    id: string;
    title: string;
    /** Every capability the preset needs holds on this Mac. */
    available: boolean;
    optIn: boolean;
    /** The saved config sends this preset's links to it. */
    routed: boolean;
    /** Saved routes that differ from the preset's current ones; see `presetDrift`. */
    drift: string[];
    /** The command that rewrites the preset's routes, set when `drift` is not empty and the preset is available. */
    fix?: string;
    /** Capabilities that do not hold, set when `drift` is not empty and `presets enable` would refuse. */
    missing?: Capability[];
}

export interface RouterStatus {
    /** GenesisTools.app, which routes the links, exists. */
    installed: boolean;
    /** macOS opens https links with GenesisTools.app, so a genesis.tools link reaches the router. */
    defaultHandler: boolean;
    httpsHandler: string | null;
    appPath: string;
    configPath: string;
    /** A config is saved and parses. */
    configured: boolean;
    presets: PresetStatus[];
    /** Available and routed: a link for one of these works on this Mac. */
    enabledPresets: string[];
}

export interface RouterStatusDeps {
    check?: CapabilityCheck;
    config?: RouterConfig | null;
    handler?: string | null;
}

/** Read-only and cheap (one `plutil`, one file read): skills and agents call it before printing a link. */
export function routerStatus(deps: RouterStatusDeps = {}): RouterStatus {
    const check = deps.check ?? hasCapability;
    const config = deps.config === undefined ? readRouterConfig() : deps.config;
    const handler = deps.handler === undefined ? httpsHandler() : deps.handler;
    const rows = presets(check).map((preset): PresetStatus => {
        const drift = config === null ? [] : presetDrift(config, preset);
        // `presets enable` refuses a preset whose capabilities do not hold, so it is no fix there.
        const missing = preset.enabledIf.filter((capability) => !check(capability));
        const repair =
            drift.length === 0
                ? {}
                : missing.length === 0
                  ? { fix: `tools browser-router presets enable ${preset.id}` }
                  : { missing };
        return {
            id: preset.id,
            title: preset.title,
            available: preset.available,
            optIn: preset.optIn === true,
            routed: config !== null && presetRouted(config, preset),
            drift,
            ...repair,
        };
    });

    return {
        installed: check("browser-router:installed"),
        defaultHandler: handler === GENESIS_APP_BUNDLE_ID,
        httpsHandler: handler,
        appPath: genesisAppBundlePath(),
        configPath: configFile(),
        configured: config !== null,
        presets: rows,
        enabledPresets: rows.filter((row) => row.available && row.routed).map((row) => row.id),
    };
}
