import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { z } from "zod";
import type { VoiceEmbeddingProvenance } from "./voice";

const resultSchema = z.discriminatedUnion("quality", [
    z.object({ quality: z.literal("ready"), model: z.string(), embedding: z.array(z.number().finite()).min(1) }),
    z.object({ quality: z.literal("unknown"), reason: z.string() }),
]);
const cacheSchema = z.object({ version: z.literal(1), entries: z.record(z.string(), resultSchema) });
type VoiceLineResult = z.infer<typeof resultSchema>;
type Entries = Record<string, VoiceLineResult>;

/** Retained source audio and recorder pieces both live below the canonical meeting folder. */
export async function voiceLineCachePath(audioPath: string): Promise<string | undefined> {
    // record's schemas import voice; resolve its folder helper only after module initialization.
    const { MeetingStore } = await import("./record");
    const store = new MeetingStore();
    const local = relative(store.root, resolve(audioPath));
    const id = local.split(/[/\\]/)[0];
    if (!id || id === ".." || isAbsolute(local) || !existsSync(store.path(id))) {
        // A copied meeting can still reference retained audio outside this store.
        const matches = store
            .list()
            .filter((record) =>
                Object.values(record.audio?.sources ?? {}).some((source) => resolve(source.path) === resolve(audioPath))
            );
        return matches.length === 1 ? join(store.folder(matches[0]!.id), "evidence", "voice-lines.json") : undefined;
    }
    return join(store.folder(id), "evidence", "voice-lines.json");
}

function readEntries(file: string): Entries {
    if (!existsSync(file)) {
        return {};
    }
    try {
        return cacheSchema.parse(SafeJSON.parse(readFileSync(file, "utf8"))).entries;
    } catch (error) {
        logger.debug({ error, file }, "Voice line cache is unreadable; recomputing embeddings");
        return {};
    }
}

/** A call-local view; each new embedding pass reopens the persisted results. */
export class VoiceLineCache {
    private readonly file: string | undefined;
    private readonly entries: Entries;
    private readonly changed: Entries = {};

    constructor(
        private readonly options: { source: VoiceEmbeddingProvenance["source"]; model: string; cachePath?: string }
    ) {
        this.file = options.cachePath;
        this.entries = this.file ? readEntries(this.file) : {};
    }

    private key(span: Omit<VoiceEmbeddingProvenance, "source">): string {
        return createHash("sha256")
            .update(
                SafeJSON.stringify([
                    this.options.model,
                    this.options.source,
                    span.channel,
                    span.track,
                    Math.round(span.fromSec * 1000),
                    Math.round(span.toSec * 1000),
                ])
            )
            .digest("hex");
    }

    get(span: Omit<VoiceEmbeddingProvenance, "source">): VoiceLineResult | undefined {
        return this.entries[this.key(span)];
    }

    set(span: Omit<VoiceEmbeddingProvenance, "source">, result: VoiceLineResult): void {
        const key = this.key(span);
        this.changed[key] = this.entries[key] = result;
    }

    save(): void {
        if (!this.file || !Object.keys(this.changed).length) {
            return;
        }
        try {
            const entries = { ...readEntries(this.file), ...this.changed };
            atomicWriteFileSync(this.file, SafeJSON.stringify({ version: 1, entries }), { mode: 0o600 });
        } catch (error) {
            logger.debug({ error, file: this.file }, "Voice line cache could not be saved");
        }
    }
}
