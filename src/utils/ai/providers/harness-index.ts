import type { NativeSessionReader } from "@genesiscz/utils/agent-sessions/types";
import { ACCOUNT_PROVIDER_ALIASES } from "@genesiscz/utils/ai/providers/alias-list";
import type {
    ExitCommand,
    HostResolver,
    LaunchRecipe,
    ProcessSignature,
    TranscriptFacts,
    TranscriptLocator,
    TurnStateReader,
} from "@genesiscz/utils/harness/parts";
import { type HarnessDriver, type HarnessId, isPartNote, type PartNote } from "@genesiscz/utils/harness/types";
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

/** A part every harness carries; a note in its slot is a broken driver, so it throws with the note's reason. */
function requiredPart<T>(id: HarnessId, slot: T | PartNote, what: string): T {
    if (isPartNote(slot)) {
        throw new Error(`The ${id} harness driver has no ${what}: ${slot.reason}`);
    }

    return slot;
}

/** The launch recipe of a harness. */
export function harnessLaunch(id: HarnessId): LaunchRecipe {
    return requiredPart(id, harnessDriver(id).parts.launch, "launch recipe");
}

/** The history reader of a harness (its driver's lazy `history` part). */
export async function harnessHistory(id: HarnessId): Promise<NativeSessionReader> {
    return requiredPart(id, harnessDriver(id).parts.history, "history reader")();
}

/** Where a harness keeps its transcripts (its driver's `locate` part). */
export function harnessLocate(id: HarnessId): TranscriptLocator {
    return requiredPart(id, harnessDriver(id).parts.locate, "transcript locator");
}

/** The turn-state reader of a harness (its driver's `turnState` part). */
export function harnessTurnState(id: HarnessId): TurnStateReader {
    return requiredPart(id, harnessDriver(id).parts.turnState, "turn-state reader");
}

/** How a harness is recognised from the environment of a process it started. */
export function harnessHost(id: HarnessId): HostResolver {
    return requiredPart(id, harnessDriver(id).parts.host, "host resolver");
}

/** How a harness's CLI is recognised in a process command line. */
export function harnessProcess(id: HarnessId): ProcessSignature {
    return requiredPart(id, harnessDriver(id).parts.process, "process signature");
}

/** What a `tools <agent>` worker of the harness can do. */
export function harnessWorker(id: HarnessId): WorkerCapabilities {
    return requiredPart(id, harnessDriver(id).parts.worker, "worker capabilities");
}

/** The static facts about a harness's transcript shape. */
export function harnessTranscriptFacts(id: HarnessId): TranscriptFacts {
    return requiredPart(id, harnessDriver(id).parts.transcript, "transcript facts");
}

/** The slash command that ends an interactive session of the harness. */
export function harnessExit(id: HarnessId): ExitCommand {
    return requiredPart(id, harnessDriver(id).parts.exit, "exit command");
}

/** The harness whose host part reports this runtime agent name (`claude-code` is Claude), or null for a non-harness. */
export function harnessOfRuntimeAgent(agent: string): HarnessId | null {
    return harnessDrivers().find((driver) => harnessHost(driver.id).agent === agent)?.id ?? null;
}
