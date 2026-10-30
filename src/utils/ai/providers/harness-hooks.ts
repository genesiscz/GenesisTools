import type { HookFacts } from "@genesiscz/utils/harness/parts";
import type { HarnessId } from "@genesiscz/utils/harness/types";
import { claudeHooks } from "./plugins/anthropic-sub/harness-hooks";
import { grokHooks } from "./plugins/grok-sub/harness-hooks";
import { codexHooks } from "./plugins/openai-sub/harness-hooks";

/**
 * The light door to each driver's `hooks` part, for the hook processes: it imports the three hook-fact modules and no
 * driver, because the drivers' other parts cost a hook several milliseconds (`harness-index.ts` added 6.1 to 7.5 ms
 * after the hook config, measured 2026-10-31). Each entry is the object its driver carries as `parts.hooks`;
 * `src/utils/harness/conformance.test.ts` fails when the two differ.
 */
const HOOKS: { readonly [Id in HarnessId]: HookFacts } = {
    claude: claudeHooks,
    codex: codexHooks,
    grok: grokHooks,
};

export function harnessHooks(id: HarnessId): HookFacts {
    return HOOKS[id];
}
