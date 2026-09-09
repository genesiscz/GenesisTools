import { PROVIDER_ALIASES } from "@genesiscz/utils/ai/providers/aliases";
import { registerBuiltInPlugins } from "@genesiscz/utils/ai/providers/plugins";
import { providerPlugin } from "@genesiscz/utils/ai/providers/registry";
import type { AgentKind, NativeSessionReader } from "./types";

export interface HistoryProvider {
    id: string;
    reader: NativeSessionReader<string>;
}

export function resolveHistoryProvider(input: string): HistoryProvider {
    registerBuiltInPlugins();
    const name = input.trim();
    const plugin = providerPlugin(PROVIDER_ALIASES[name.toLowerCase()] ?? name);
    const reader = plugin.codingAgent;

    if (!reader) {
        throw new Error(`${plugin.id} has no native session reader`);
    }

    return { id: plugin.id, reader };
}

export function readerHasKind(reader: NativeSessionReader<string>, kind: AgentKind): reader is NativeSessionReader {
    return reader.kind === kind;
}
