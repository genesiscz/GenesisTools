import { localPlugins } from "../local/adapters";
import { aiProxyPlugin } from "./plugins/ai-proxy";
import { anthropicSubPlugin } from "./plugins/anthropic-sub";
import { apiKeyPlugins } from "./plugins/api-key";
import { asrVendorPlugins } from "./plugins/asr-vendors";
import { githubCopilotPlugin } from "./plugins/github-copilot";
import { grokSubPlugin } from "./plugins/grok-sub";
import { openAiSubPlugin } from "./plugins/openai-sub";
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
    registerPlugin(openAiSubPlugin);
    registerPlugin(grokSubPlugin);
    registerPlugin(githubCopilotPlugin);
    registerPlugin(aiProxyPlugin);

    for (const plugin of [...apiKeyPlugins, ...asrVendorPlugins, ...localPlugins]) {
        registerPlugin(plugin);
    }

    registered = true;
}

/**
 * `state = true` claims the built-ins are already registered, which is how a
 * test substitutes fakes for real plugins under the SAME ids (the chain in
 * `tasks/resolve-task.ts` is ordered by real provider ids, so renaming the fakes
 * would test a different order than the one that ships).
 */
export function _resetBuiltInPluginsForTest(state = false): void {
    registered = state;
}
