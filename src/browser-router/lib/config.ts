import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { type CapabilityCheck, hasCapability } from "@genesiscz/utils/browser-router/capabilities";
import { browserRouterStorage, configFile } from "@genesiscz/utils/browser-router/config";
import { applyPresets, presetById, presets } from "@genesiscz/utils/browser-router/presets";
import {
    type BrowserTarget,
    bindTemplateNames,
    compileUrlTemplate,
    defaultRouterConfig,
    isHostName,
    type PresetOptions,
    parseConfig,
    type RouteAction,
    type RouteRule,
    type RouterConfig,
    type ToastSettings,
} from "@genesiscz/utils/browser-router/route";
import { suggestCommand } from "@genesiscz/utils/cli";
import { SafeJSON } from "@genesiscz/utils/json";
import { withFileLock } from "@genesiscz/utils/storage";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";

/** Printed wherever a link host is chosen: a link the router misses goes to that host's server. */
export const LINK_HOST_RISK =
    "A link the router does not catch (opened on a phone, on another computer, or in a browser without the extension) goes to whoever serves this host, path and all. A minted link's path is a one-use token. Pick a host you control, or accept that.";

/** The link host, or an error naming the command that sets it. */
export function requireLinkHost(config: RouterConfig | null): string {
    if (config?.linkHost) {
        return config.linkHost;
    }

    throw new Error(
        `No link host is set, so no link can be printed. Set one: ${suggestCommand("tools browser-router", {
            replaceCommand: ["link-host", "<host>"],
        })}`
    );
}

export function stateFile(name: string): string {
    return `${browserRouterStorage().getBaseDir()}/${name}`;
}

export async function loadConfig(): Promise<RouterConfig | null> {
    const file = Bun.file(configFile());

    if (!(await file.exists())) {
        return null;
    }

    return parseConfig(SafeJSON.parse(await file.text(), { strict: true }));
}

/** Temp file plus rename: GenesisTools.app reads this file on every click and must never see half of it. */
export async function saveConfig(config: RouterConfig): Promise<void> {
    const storage = browserRouterStorage();
    await storage.ensureDirs();
    atomicWriteFileSync(configFile(), `${SafeJSON.stringify(parseConfig(config), null, 2)}\n`);
}

/**
 * One cross-process lock from load to save, so two `route` or `install` runs cannot each read the
 * old file and drop the other's change. Not re-entrant: the functions below take it once at the top.
 */
async function withConfigLock<T>(fn: () => Promise<T>): Promise<T> {
    const lock = `${configFile()}.lock`;
    mkdirSync(dirname(lock), { recursive: true });
    return withFileLock(lock, fn);
}

export function ensureBuiltinRoutes(): Promise<RouterConfig> {
    return withConfigLock(ensureBuiltinRoutesLocked);
}

/**
 * The saved routes rebuilt from the presets: default presets first, the user's own routes, then the
 * installable presets `config.presets` switched on. Only a change is written.
 */
async function ensureBuiltinRoutesLocked(check: CapabilityCheck = hasCapability): Promise<RouterConfig> {
    const config = await ensureConfig();
    const next = withPresetRoutes(
        { ...config, toast: config.toast === undefined ? { enabled: true, seconds: 5 } : config.toast },
        check
    );

    if (SafeJSON.stringify(next) !== SafeJSON.stringify(config)) {
        await saveConfig(next);
    }

    return next;
}

function withPresetRoutes(config: RouterConfig, check: CapabilityCheck): RouterConfig {
    return { ...config, routes: applyPresets(config.routes, presets({ config, check })) };
}

export async function ensureConfig(): Promise<RouterConfig> {
    const existing = await loadConfig();

    if (existing) {
        return existing;
    }

    const created = defaultRouterConfig(preferredDefaultBrowser());
    await saveConfig(created);
    return created;
}

/** Switches an installable preset on (with its options) and rewrites the routes. */
export function enablePreset({
    id,
    options = {},
    check = hasCapability,
}: {
    id: string;
    options?: PresetOptions;
    check?: CapabilityCheck;
}): Promise<RouterConfig> {
    return withConfigLock(async () => {
        const config = await ensureConfig();
        const catalogue = presets({ config, check });
        const preset = presetById(id, catalogue);

        if (!preset) {
            throw new Error(`no preset named ${id}; the presets are ${catalogue.map((item) => item.id).join(", ")}`);
        }

        if (preset.kind === "default") {
            throw new Error(`${id} is a default preset: it is always on when it can be`);
        }

        const unknown = Object.keys(options).filter((name) => !preset.options?.includes(name as keyof PresetOptions));

        if (unknown.length > 0) {
            throw new Error(`${id} takes no option ${unknown.join(", ")}`);
        }

        if (!preset.available) {
            throw new Error(`${id} needs ${preset.missing.join(", ")}`);
        }

        const next = withPresetRoutes({ ...config, presets: { ...config.presets, [id]: options } }, check);
        await saveConfig(next);
        return next;
    });
}

/** Switches an installable preset off and removes its routes. */
export function disablePreset(id: string, check: CapabilityCheck = hasCapability): Promise<RouterConfig> {
    return withConfigLock(async () => {
        const config = await ensureConfig();

        if (config.presets?.[id] === undefined) {
            throw new Error(`${id} is not enabled`);
        }

        const { [id]: _removed, ...rest } = config.presets;
        const next = withPresetRoutes({ ...config, presets: rest }, check);
        await saveConfig(next);
        return next;
    });
}

/** Sets (or, with null, clears) the host printed links are built on, and rewrites the routes. */
export function setLinkHost(host: string | null, check: CapabilityCheck = hasCapability): Promise<RouterConfig> {
    return withConfigLock(async () => {
        const config = await ensureConfig();
        const value = host?.trim().toLowerCase() ?? null;

        if (value !== null && !isHostName(value)) {
            throw new Error(`${host} is not a host name, e.g. links.example.com`);
        }

        const { linkHost: _old, ...rest } = config;
        const next = withPresetRoutes(value === null ? rest : { ...rest, linkHost: value }, check);
        await saveConfig(next);
        return next;
    });
}

export function upsertRoute(rule: RouteRule): Promise<RouterConfig> {
    return withConfigLock(async () => {
        const config = (await loadConfig()) ?? defaultRouterConfig(preferredDefaultBrowser());
        const routes = config.routes.filter((item) => item.pattern !== rule.pattern);
        routes.push(rule);
        const next = { ...config, routes };
        await saveConfig(next);
        return next;
    });
}

export function deleteRoute(pattern: string): Promise<RouterConfig> {
    return withConfigLock(async () => {
        const config = await loadConfig();

        if (!config) {
            throw new Error(`no config at ${configFile()}`);
        }

        const next = { ...config, routes: config.routes.filter((item) => item.pattern !== pattern) };

        if (next.routes.length === config.routes.length) {
            throw new Error(`no route with pattern ${pattern}`);
        }

        await saveConfig(next);
        return next;
    });
}

export function preferredDefaultBrowser(): BrowserTarget {
    if (existsSync("/Applications/Brave Browser.app")) {
        return { name: "com.brave.Browser", appType: "bundleId" };
    }

    if (existsSync("/Applications/Google Chrome.app")) {
        return { name: "com.google.Chrome", appType: "bundleId" };
    }

    return { name: "com.apple.Safari", appType: "bundleId" };
}

export function routeFromFlags(pattern: string, flags: RouteFlags): RouteRule {
    if (flags.delete) {
        throw new Error("delete is not a route action");
    }

    const toast = toastFromFlags(flags);
    const named = flags.name ? { name: flags.name } : {};
    const compiled = compileUrlTemplate(pattern);
    const storedPattern = compiled?.pattern ?? pattern;
    const names = compiled?.names ?? [];
    const bind = (value: string) => bindTemplateNames(value, names);

    const chosen = [flags.routeTo, flags.tool, flags.run].filter((value) => value !== undefined);

    if (chosen.length > 1) {
        throw new Error("pass only one of --route-to, --tool, or --run");
    }

    if (flags.routeTo) {
        return { pattern: storedPattern, action: { type: "open", to: bind(flags.routeTo) }, ...named, ...toast };
    }

    if (flags.run) {
        const approval = readApprovalFlag(flags.approval);
        const action: RouteAction = {
            type: "run",
            argv: [flags.run, ...(flags.arg ?? []).map(bind)],
            approval,
            ...(flags.touchId ? { touchId: true } : {}),
            ...(flags.open === undefined ? {} : { open: bind(flags.open) }),
            ...(flags.notify === undefined ? {} : { notify: bind(flags.notify) }),
        };
        return { pattern: storedPattern, action, ...named, ...toast };
    }

    if (flags.tool) {
        const action: RouteAction = {
            type: "tool",
            tool: flags.tool,
            args: (flags.arg ?? []).map(bind),
            approval: readApprovalFlag(flags.approval),
        };
        return { pattern: storedPattern, action, ...named, ...toast };
    }

    throw new Error("pass --route-to <template>, --run <program>, or --tool <name>");
}

function toastFromFlags(flags: RouteFlags): { toast?: ToastSettings } {
    // Commander turns `--no-toast` into `toast: false`; `noToast` is the programmatic spelling.
    const noToast = flags.toast === false || flags.noToast === true;

    if (!noToast && flags.toastSeconds === undefined && flags.toastTitle === undefined) {
        return {};
    }

    if (noToast) {
        return { toast: false };
    }

    const toast: { enabled?: boolean; seconds?: number; title?: string } = {};

    if (flags.toastSeconds !== undefined) {
        const seconds = Number(flags.toastSeconds);

        if (!Number.isFinite(seconds) || seconds < 0) {
            throw new Error("--toast-seconds must be a number of seconds");
        }

        toast.seconds = seconds;
    }

    if (flags.toastTitle !== undefined) {
        toast.title = flags.toastTitle;
    }

    return { toast };
}

function readApprovalFlag(value: string | undefined): "ask" | "allow" {
    const approval = value ?? "ask";

    if (approval !== "ask" && approval !== "allow") {
        throw new Error("--approval must be ask or allow");
    }

    return approval;
}

export interface RouteFlags {
    name?: string;
    routeTo?: string;
    tool?: string;
    run?: string;
    arg?: string[];
    open?: string;
    notify?: string;
    approval?: string;
    touchId?: boolean;
    /** `false` from `--no-toast`. */
    toast?: boolean;
    noToast?: boolean;
    toastSeconds?: string;
    toastTitle?: string;
    delete?: boolean;
}
