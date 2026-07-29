import { anthropicSubPlugin } from "./plugins/anthropic-sub";
import { apiKeyPlugins } from "./plugins/api-key";
import { registerPlugin } from "./registry";

/**
 * The barrel every provider must appear in.
 *
 * Bun executes TypeScript directly, so there is no bundler glob import to
 * register plugins automatically. `registry.test.ts` globs the plugins folder and
 * fails when a file here is missing, which turns the manual step into a caught
 * error rather than a provider that silently does not exist.
 */
let registered = false;

export function registerBuiltInPlugins(): void {
    if (registered) {
        return;
    }

    registerPlugin(anthropicSubPlugin);
    for (const plugin of apiKeyPlugins) {
        registerPlugin(plugin);
    }

    registered = true;
}

export function _resetBuiltInPluginsForTest(): void {
    registered = false;
}
