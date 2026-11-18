import { existsSync, readFileSync } from "node:fs";
import { SafeJSON } from "@genesiscz/utils/json";
import { projectNameSchema } from "@genesiscz/utils/meetings/config";
import { nameKey } from "@genesiscz/utils/meetings/people";
import { localVoiceBackend } from "@genesiscz/utils/meetings/voice";
import { withPathArbitrationSync } from "@genesiscz/utils/process/path-arbitration";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { z } from "zod";

export const voicePrintSchema = z
    .object({
        meeting: z.string().min(1),
        sourceSha: z.string().min(1),
        seat: z.enum(["mic", "call"]),
        track: z.enum(["source-mic", "source-call", "mic-raw", "system"]),
        fromSec: z.number().nonnegative(),
        toSec: z.number().positive(),
        embedding: z.array(z.number().finite()).min(1),
        confirmedAt: z.string().min(1),
        question: z.string().optional(),
    })
    .refine(
        (print) =>
            print.toSec > print.fromSec &&
            (print.seat === "mic" ? ["source-mic", "mic-raw"] : ["source-call", "system"]).includes(print.track),
        "Voice print needs a valid interval and a track of its seat"
    );
export type VoicePrint = z.infer<typeof voicePrintSchema>;

export const voiceStoreSchema = z.object({
    version: z.literal(1),
    model: z.string(),
    people: z.record(z.string(), z.object({ samples: z.array(voicePrintSchema) })),
});
export type VoiceStore = z.infer<typeof voiceStoreSchema>;

function storeFile(project: string): string {
    return toolDataDir("meetings", "voices", `${projectNameSchema.parse(project)}.json`);
}

export function readVoiceStore(project: string): VoiceStore {
    const file = storeFile(project);
    return existsSync(file)
        ? voiceStoreSchema.parse(SafeJSON.parse(readFileSync(file, "utf8")))
        : { version: 1, model: "", people: {} };
}

/** A single model owns a store; incompatible prints must never be silently mixed. */
function putVoicePrint(store: VoiceStore, person: string, print: VoicePrint, model?: string): void {
    const checked = voicePrintSchema.parse(print);
    if (!person.trim()) {
        throw new Error("A voice print needs a person");
    }
    if (model && store.model && model !== store.model) {
        throw new Error("Voice model changed; remove incompatible project prints before enrolling again");
    }
    store.model = model ?? (store.model || localVoiceBackend().model);
    if (!store.model) {
        throw new Error("The first voice print needs its model identity");
    }
    const samples = store.people[person]?.samples ?? [];
    const same = (sample: VoicePrint) =>
        sample.meeting === checked.meeting &&
        sample.sourceSha === checked.sourceSha &&
        sample.seat === checked.seat &&
        sample.track === checked.track &&
        sample.fromSec === checked.fromSec &&
        sample.toSec === checked.toSec;
    store.people[person] = { samples: [...samples.filter((sample) => !same(sample)), checked] };
}

/** Historical samples identify the confirmed source interval, even if another track describes it. */
export function voicePrintKey(person: string, print: VoicePrint): string {
    return SafeJSON.stringify([nameKey(person), print.meeting, print.sourceSha, print.fromSec, print.toSec]);
}

/** Publish all recovered samples in one project-file replacement. Check the plan again under the writer lock. */
export function addVoicePrints(
    project: string,
    changes: readonly { person: string; after: VoicePrint; model?: string }[],
    requireMissing = false
): void {
    if (!changes.length) {
        return;
    }
    const file = storeFile(project);
    withPathArbitrationSync(file, () => {
        const store = readVoiceStore(project);
        if (requireMissing) {
            const keys = new Set(
                Object.entries(store.people).flatMap(([name, row]) =>
                    row.samples.map((print) => voicePrintKey(name, print))
                )
            );
            if (changes.some(({ person, after }) => keys.has(voicePrintKey(person, after)))) {
                throw new Error("The project's voice samples changed during backfill. Retry to count the new samples.");
            }
        }
        for (const change of changes) {
            putVoicePrint(store, change.person, change.after, change.model);
        }
        atomicWriteFileSync(file, SafeJSON.stringify(store));
    });
}

export function addVoicePrint(project: string, person: string, print: VoicePrint, model?: string): void {
    addVoicePrints(project, [{ person, after: print, model }]);
}

export function removeVoicePrint(project: string, person: string, at?: { meeting: string; fromSec: number }): number {
    const file = storeFile(project);
    if (!existsSync(file)) {
        return 0;
    }
    return withPathArbitrationSync(file, () => {
        const store = readVoiceStore(project);
        const samples = store.people[person]?.samples ?? [];
        const remaining = at
            ? samples.filter((sample) => sample.meeting !== at.meeting || sample.fromSec !== at.fromSec)
            : [];
        const removed = samples.length - remaining.length;
        if (removed === 0) {
            return 0;
        }
        if (remaining.length) {
            store.people[person] = { samples: remaining };
        } else {
            delete store.people[person];
        }
        atomicWriteFileSync(file, SafeJSON.stringify(store));
        return removed;
    });
}
