import type { NativeSessionReader } from "@genesiscz/utils/agent-sessions/types";
import { ACCOUNT_PROVIDER_ALIASES } from "@genesiscz/utils/ai/providers/alias-list";
import type { HostResolver, LaunchRecipe, ProcessSignature } from "@genesiscz/utils/harness/parts";
import { type HarnessDriver, type HarnessId, isPartNote } from "@genesiscz/utils/harness/types";
import type { WorkerCapabilities } from "@genesiscz/utils/worker/capabilities";
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

/** The launch recipe of a harness; every harness has one, so a note here is a broken driver. */
export function harnessLaunch(id: HarnessId): LaunchRecipe {
    const slot = harnessDriver(id).parts.launch;

    if (isPartNote(slot)) {
        throw new Error(`The ${id} harness driver has no launch recipe: ${slot.reason}`);
    }

    return slot;
}

/** The history reader of a harness (its driver's lazy `history` part); every harness has one. */
export async function harnessHistory(id: HarnessId): Promise<NativeSessionReader> {
    const slot = harnessDriver(id).parts.history;

    if (isPartNote(slot)) {
        throw new Error(`The ${id} harness driver has no history reader: ${slot.reason}`);
    }

    return slot();
}

/** How a harness is recognised from the environment of a process it started; every harness has one. */
export function harnessHost(id: HarnessId): HostResolver {
    const slot = harnessDriver(id).parts.host;

    if (isPartNote(slot)) {
        throw new Error(`The ${id} harness driver has no host resolver: ${slot.reason}`);
    }

    return slot;
}

/** How a harness's CLI is recognised in a process command line; every harness has one. */
export function harnessProcess(id: HarnessId): ProcessSignature {
    const slot = harnessDriver(id).parts.process;

    if (isPartNote(slot)) {
        throw new Error(`The ${id} harness driver has no process signature: ${slot.reason}`);
    }

    return slot;
}

/** What a `tools <agent>` worker of the harness can do; every harness has workers. */
export function harnessWorker(id: HarnessId): WorkerCapabilities {
    const slot = harnessDriver(id).parts.worker;

    if (isPartNote(slot)) {
        throw new Error(`The ${id} harness driver has no worker capabilities: ${slot.reason}`);
    }

    return slot;
}

/**
 * A table with one entry per harness, each read from its driver. For an old `Record<HarnessId, T>` export whose
 * callers index it by name: the table stays, its values come from the drivers, and the mapped type still refuses a
 * harness without an entry.
 */
export function byHarness<T>(pick: (id: HarnessId) => T): Readonly<Record<HarnessId, T>> {
    return { claude: pick("claude"), codex: pick("codex"), grok: pick("grok") };
}
