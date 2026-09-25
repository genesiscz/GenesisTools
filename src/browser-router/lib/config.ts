import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { type CapabilityCheck, hasCapability } from "@genesiscz/utils/browser-router/capabilities";
import { browserRouterStorage, configFile } from "@genesiscz/utils/browser-router/config";
import { applyPresets, presetById } from "@genesiscz/utils/browser-router/presets";
import {
    type BrowserTarget,
    bindTemplateNames,
    builtinRoutes,
    compileUrlTemplate,
    defaultAliases,
    defaultRouterConfig,
    parseConfig,
    type RouteAction,
    type RouteRule,
    type RouterConfig,
    type ToastSettings,
} from "@genesiscz/utils/browser-router/route";
import { SafeJSON } from "@genesiscz/utils/json";
import { withFileLock } from "@genesiscz/utils/storage";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";
import { listPortRegistry } from "@genesiscz/utils/ui/dashboards";

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

async function ensureBuiltinRoutesLocked(): Promise<RouterConfig> {
    const config = await ensureConfig();
    const builtins = builtinRoutes();
    const seen = new Set<string>(builtins.map((route) => route.pattern));
    const rest = config.routes.filter((route) => {
        if (seen.has(route.pattern)) {
            return false;
        }
        seen.add(route.pattern);
        return true;
    });
    const routes: RouteRule[] = applyPresets([...builtins, ...rest]);
    const next = {
        ...config,
        allowAliases: config.allowAliases !== false,
        aliases: config.aliases ?? defaultAliases(),
        toast: config.toast === undefined ? { enabled: true, seconds: 5 } : config.toast,
        services: listPortRegistry()
            .filter((entry) => entry.launch && entry.port !== 6666)
            .map((entry) => ({ port: entry.port, name: entry.name })),
        routes,
    };

    const changed =
        SafeJSON.stringify(next.routes) !== SafeJSON.stringify(config.routes) ||
        next.allowAliases !== config.allowAliases ||
        SafeJSON.stringify(next.aliases) !== SafeJSON.stringify(config.aliases) ||
        SafeJSON.stringify(next.toast) !== SafeJSON.stringify(config.toast) ||
        SafeJSON.stringify(next.services) !== SafeJSON.stringify(config.services);

    if (changed) {
        await saveConfig(next);
    }

    return next;
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

/**
 * Writes a preset's routes into the saved config, tagged with its id, so `install` keeps them while
 * the preset's capabilities hold. The way to switch on an opt-in preset such as `decide`.
 */
export function enablePreset(id: string, check: CapabilityCheck = hasCapability): Promise<RouterConfig> {
    return withConfigLock(async () => {
        const preset = presetById(id, check);

        if (!preset) {
            throw new Error(`no preset named ${id}. See: tools browser-router presets`);
        }

        if (!preset.available) {
            throw new Error(`${id} needs ${preset.enabledIf.join(", ")} on this Mac`);
        }

        const config = await ensureConfig();
        const patterns = new Set(preset.routes.map((rule) => rule.pattern));
        // A route tagged with this preset belongs to it, so one whose pattern it dropped goes too
        // (`status` reports it as drift and names this command as the fix).
        const next = {
            ...config,
            routes: [
                ...config.routes.filter((rule) => !patterns.has(rule.pattern) && rule.preset !== id),
                ...preset.routes,
            ],
        };
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
