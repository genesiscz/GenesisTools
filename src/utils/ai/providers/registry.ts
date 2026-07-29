import { logger } from "@genesiscz/utils/logger";
import type { Capability, ProviderPlugin } from "./plugin-types";

/**
 * The provider registry. Adding a provider is one folder plus one line in
 * `plugins.ts`; nothing in the core changes. A test globs the folder and fails
 * if a plugin was written but never registered, so the manual step cannot be
 * silently forgotten (Bun runs TypeScript directly, so there is no bundler glob
 * import to do it automatically).
 */

const plugins = new Map<string, ProviderPlugin>();

export function registerPlugin(plugin: ProviderPlugin): void {
    if (plugins.has(plugin.id)) {
        throw new Error(`Provider plugin "${plugin.id}" is registered twice.`);
    }

    plugins.set(plugin.id, plugin);
    logger.debug({ provider: plugin.id, kind: plugin.kind }, "registered provider plugin");
}

export class UnknownProviderError extends Error {
    constructor(id: string, known: string[]) {
        super(`Unknown AI provider "${id}". Known providers: ${known.join(", ") || "none registered"}.`);
        this.name = "UnknownProviderError";
    }
}

export function providerPlugin(id: string): ProviderPlugin {
    const plugin = plugins.get(id);
    if (!plugin) {
        throw new UnknownProviderError(id, [...plugins.keys()].sort());
    }

    return plugin;
}

export function tryProviderPlugin(id: string): ProviderPlugin | undefined {
    return plugins.get(id);
}

export function allProviderPlugins(): ProviderPlugin[] {
    return [...plugins.values()];
}

export function pluginsByCapability(capability: Capability): ProviderPlugin[] {
    return allProviderPlugins().filter((plugin) => plugin.capabilities.has(capability));
}

export function registeredProviderIds(): string[] {
    return [...plugins.keys()].sort();
}

export function _resetPluginsForTest(): void {
    plugins.clear();
}
