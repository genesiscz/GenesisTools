import { ACCOUNT_PROVIDER_ALIASES } from "@genesiscz/utils/ai/providers/alias-list";
import type { HarnessDriver, HarnessId } from "@genesiscz/utils/harness/types";
import { claudeHarness } from "./plugins/anthropic-sub/harness";
import { grokHarness } from "./plugins/grok-sub/harness";
import { codexHarness } from "./plugins/openai-sub/harness";

/**
 * The light door to the harness drivers, for code that must not load the provider registry (about 130 ms: a hook, the
 * statusline, a label in a list). It holds no data of its own: each entry is the driver object its provider plugin
 * carries as `ProviderPlugin.harness`, and `src/utils/harness/conformance.test.ts` fails when the two differ. Adding a
 * harness is its plugin plus one entry here, and the mapped type refuses an index without it.
 */
const DRIVERS: { readonly [Id in HarnessId]: HarnessDriver<Id> } = {
    claude: claudeHarness,
    codex: codexHarness,
    grok: grokHarness,
};

export function harnessDriver<Id extends HarnessId>(id: Id): HarnessDriver<Id> {
    return DRIVERS[id];
}

/** Every driver, in the canonical alias order. */
export function harnessDrivers(): HarnessDriver[] {
    return ACCOUNT_PROVIDER_ALIASES.map((id) => harnessDriver(id));
}

export function harnessLabel(id: HarnessId): string {
    return harnessDriver(id).identity.label;
}

export function harnessPluginId(id: HarnessId): string {
    return harnessDriver(id).identity.plugin;
}

/** The harness whose host part reports this runtime agent name (`claude-code` is Claude), or null for a non-harness. */
export function harnessOfRuntimeAgent(agent: string): HarnessId | null {
    return harnessDrivers().find((driver) => driver.parts.host.agent === agent)?.id ?? null;
}
