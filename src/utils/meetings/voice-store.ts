import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { projectNameSchema } from "@genesiscz/utils/meetings/config";
import { localVoiceBackend } from "@genesiscz/utils/meetings/voice";
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
export function addVoicePrint(project: string, person: string, print: VoicePrint, model?: string): void {
    const checked = voicePrintSchema.parse(print);
    const store = readVoiceStore(project);
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
    const file = storeFile(project);
    mkdirSync(dirname(file), { recursive: true });
    atomicWriteFileSync(file, SafeJSON.stringify(store));
}

export function removeVoicePrint(project: string, person: string, at?: { meeting: string; fromSec: number }): number {
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
    atomicWriteFileSync(storeFile(project), SafeJSON.stringify(store));
    return removed;
}
