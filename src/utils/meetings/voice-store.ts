import { localVoiceBackend } from "@genesiscz/utils/meetings/voice";
import { addProjectVoicePrints, type VoicePrint } from "./voice-library";

export {
    projectVoiceStore as readVoiceStore,
    removeProjectVoicePrint as removeVoicePrint,
    type VoicePrint,
    type VoiceStore,
    voicePrintKey,
    voicePrintSchema,
    voiceStoreSchema,
} from "./voice-library";

/** Publish all recovered samples together and recheck the backfill plan under the library lock. */
export function addVoicePrints(
    project: string,
    changes: readonly { person: string; after: VoicePrint; model?: string }[],
    requireMissing = false
): void {
    addProjectVoicePrints({ project, changes, requireMissing, defaultModel: () => localVoiceBackend().model });
}

export function addVoicePrint(project: string, person: string, print: VoicePrint, model?: string): void {
    addVoicePrints(project, [{ person, after: print, model }]);
}
