import { AiConfigStore } from "../config/AiConfigStore";
import type { Capability } from "../providers/plugin-types";
import { registerBuiltInPlugins } from "../providers/plugins";
import { pluginsByCapability } from "../providers/registry";
import { taskModelDefault } from "./task-models";

export interface TaskAccountChoice {
    id: string;
    name: string;
    provider: string;
    modelRef: string;
    defaultModel: string | null;
    local: boolean;
}

/** Metadata only: no credential resolution, binding, migration, or model download. */
export async function listTaskAccountChoices(capability: Capability): Promise<TaskAccountChoice[]> {
    registerBuiltInPlugins();
    const store = await AiConfigStore.readOnly();
    const disabled = new Set(store.data().disabledProviders ?? []);
    const plugins = new Map(pluginsByCapability(capability).map((plugin) => [plugin.id, plugin]));
    return store.accounts({ enabled: true }).flatMap((account) => {
        const plugin = plugins.get(account.provider);
        if (!plugin || disabled.has(account.provider)) {
            return [];
        }
        return [
            {
                id: account.id,
                name: account.name,
                provider: account.provider,
                modelRef: `@account/${account.id}`,
                defaultModel: taskModelDefault(account.provider, capability) ?? null,
                local: plugin.kind === "local",
            },
        ];
    });
}
