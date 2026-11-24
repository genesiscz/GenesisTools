import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { FileIdentityCache, fileIdentity } from "@genesiscz/utils/fs/identity-cache";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { withFileLock } from "@genesiscz/utils/storage/file-lock";
import { z } from "zod";
import type { VoiceEmbeddingProvenance } from "./voice";

export const voiceLineResultSchema = z.discriminatedUnion("quality", [
    z.object({ quality: z.literal("ready"), model: z.string(), embedding: z.array(z.number().finite()).min(1) }),
    z.object({ quality: z.literal("unknown"), reason: z.string() }),
]);
/** How long a save waits for another pass that is merging the same cache; past it the results stay unsaved. */
const SAVE_LOCK_MS = 30_000;
const cacheSchema = z.object({ version: z.literal(1), entries: z.record(z.string(), voiceLineResultSchema) });
type VoiceLineResult = z.infer<typeof voiceLineResultSchema>;
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

/**
 * Parsed cache files, each served while the file keeps its identity. A pass opens one `VoiceLineCache` per audio piece,
 * and all of them read the meeting's one file: 93 parses of 6.6 MB, 1.3 s of a 2 s naming pass on a 3-hour joined
 * meeting. A parsed file holds about 3.4 MB of memory.
 */
const parsedFiles = new FileIdentityCache<Readonly<Entries>>({ limit: 4 });

function readEntries(file: string): Readonly<Entries> {
    if (!existsSync(file)) {
        return {};
    }
    // The identity before the read: a write during the read leaves a newer identity, and the next call parses again.
    const identity = fileIdentity(file);
    const parsed = parsedFiles.get(file, identity);
    if (parsed) {
        return parsed;
    }
    try {
        const entries = Object.freeze(cacheSchema.parse(SafeJSON.parse(readFileSync(file, "utf8"))).entries);
        if (identity) {
            parsedFiles.set(file, identity, entries);
        }
        return entries;
    } catch (error) {
        logger.debug({ error, file }, "Voice line cache is unreadable; recomputing embeddings");
        return {};
    }
}

/** A call-local view; each new embedding pass reopens the persisted results. */
export class VoiceLineCache {
    private readonly file: string | undefined;
    /** Read only, shared with every other view of the same file version; a lookup takes `changed` first. */
    private readonly saved: Readonly<Entries>;
    private readonly fallback: Readonly<Entries>;
    private readonly changed: Entries = {};

    constructor(
        private readonly options: {
            source: VoiceEmbeddingProvenance["source"];
            model: string;
            cachePath?: string;
            /** Another pass's cache read for hits only: `save` never writes into it. */
            fallbackCachePath?: string;
        }
    ) {
        this.file = options.cachePath;
        this.saved = this.file ? readEntries(this.file) : {};
        this.fallback = options.fallbackCachePath ? readEntries(options.fallbackCachePath) : {};
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
        const key = this.key(span);
        return this.changed[key] ?? this.saved[key] ?? this.fallback[key];
    }

    set(span: Omit<VoiceEmbeddingProvenance, "source">, result: VoiceLineResult): void {
        const key = this.key(span);
        // Keep the original on-disk representation even when validation of a worker reply reordered its fields.
        this.changed[key] =
            result.quality === "ready"
                ? { model: result.model, embedding: result.embedding, quality: "ready" }
                : result;
    }

    /** The read, merge and replace run under one lock, so two overlapping passes both keep their results. */
    async save(): Promise<void> {
        const file = this.file;
        if (!file || !Object.keys(this.changed).length) {
            return;
        }
        try {
            await withFileLock(
                `${file}.lock`,
                async () => {
                    const entries = { ...readEntries(file), ...this.changed };
                    atomicWriteFileSync(file, SafeJSON.stringify({ version: 1, entries }), { mode: 0o600 });
                },
                SAVE_LOCK_MS
            );
        } catch (error) {
            logger.debug({ error, file }, "Voice line cache could not be saved");
        }
    }
}
