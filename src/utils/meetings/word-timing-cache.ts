import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type FileIdentity, fileIdentity } from "@genesiscz/utils/fs/identity-cache";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { STORE_PACKAGES } from "@genesiscz/utils/package-store";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { withFileLock } from "@genesiscz/utils/storage/file-lock";
import { z } from "zod";
import { type AsrWordTiming, alignWordTimings, type WordTimingLine } from "./word-timings";

const identitySchema = z.object({ ino: z.number(), size: z.number(), mtimeMs: z.number(), ctimeMs: z.number() });
export const wordTimingFileSchema = z.object({ path: z.string(), identity: identitySchema });
export const wordTimingWindowSchema = z.object({
    fromSec: z.number().finite().nonnegative(),
    toSec: z.number().finite().positive(),
});
export const wordTimingSourceSchema = z.object({
    id: z.string(),
    kind: z.literal("asr"),
    modelId: z.string(),
    language: z.string(),
    runtime: z.object({ id: z.literal("transformers-js"), version: z.string() }),
    modelFingerprint: z.string(),
    audioFingerprint: z.string(),
    generatedAt: z.string(),
    policy: z.literal("exact-word-v1"),
    pcmSha256: z.string(),
});
export const alignedWordSchema = z.object({
    range: z.object({ location: z.number().int().nonnegative(), length: z.number().int().positive() }),
    startSec: z.number().finite().nonnegative(),
    endSec: z.number().finite().positive(),
    sourceId: z.string(),
});
export const wordTimingCoverageSchema = z.object({
    eligibleWords: z.number().int().nonnegative(),
    matchedWords: z.number().int().nonnegative(),
    ambiguousWords: z.number().int().nonnegative(),
    unmatchedWords: z.number().int().nonnegative(),
    invalidAsrWords: z.number().int().nonnegative(),
    invalidLinesSkipped: z.number().int().nonnegative(),
    boundaryLinesSkipped: z.number().int().nonnegative(),
});
export const wordTimingMetadataSchema = z.object({
    state: z.enum(["missing", "stale", "ready"]),
    revision: z.string(),
    windows: z.array(wordTimingWindowSchema.extend({ coverage: wordTimingCoverageSchema })),
    sources: z.array(wordTimingSourceSchema),
});
export const wordTimingGenerateResultSchema = z.object({
    meeting: z.string(),
    cacheRevision: z.string(),
    reused: z.boolean(),
    window: wordTimingWindowSchema,
    coverage: wordTimingCoverageSchema,
    provenance: wordTimingSourceSchema,
});

const rawWordSchema = z.object({ text: z.string(), startSec: z.number(), endSec: z.number() });
const artifactSchema = z.object({
    // Version 2 decodes on the container clock and fingerprints the runtime's actual cache.
    version: z.literal(2),
    window: wordTimingWindowSchema,
    source: wordTimingSourceSchema,
    audio: wordTimingFileSchema,
    modelFiles: z.array(wordTimingFileSchema).min(1).max(256),
    rawWords: z.array(rawWordSchema).max(512),
    transcriptFingerprint: z.string(),
});
const manifestSchema = z.object({
    version: z.literal(1),
    windows: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(4096),
});
export type WordTimingFile = z.infer<typeof wordTimingFileSchema>;
export type WordTimingSource = z.infer<typeof wordTimingSourceSchema>;
export type WordTimingArtifact = z.infer<typeof artifactSchema>;
export type TimedTranscriptWord = z.infer<typeof alignedWordSchema>;
export type TimedTranscriptLine = WordTimingLine & { words?: TimedTranscriptWord[] };
export interface WordTimingRead<T extends WordTimingLine> {
    entries: Array<T & { words?: TimedTranscriptWord[] }>;
    wordTimings: {
        state: "missing" | "stale" | "ready";
        revision: string;
        windows: Array<{ fromSec: number; toSec: number; coverage: ReturnType<typeof alignWordTimings>["coverage"] }>;
        sources: WordTimingSource[];
    };
}

const { log } = logger.scoped("meetings-word-timings");
const MAX_CACHE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_CACHE_READ_BYTES = 8 * 1024 * 1024;
interface ReadBudget {
    remaining: number;
    exceeded: boolean;
}

export function wordTimingHash(value: unknown): string {
    return createHash("sha256").update(SafeJSON.stringify(value)).digest("hex");
}

export function wordTimingTranscriptFingerprint(lines: readonly WordTimingLine[]): string {
    return wordTimingHash(lines.map(({ id, text, startSec, endSec }) => ({ id, text, startSec, endSec })));
}

export function wordTimingFile(path: string): WordTimingFile {
    const identity = fileIdentity(path);
    if (!identity) {
        throw new Error(`Word timing input is not readable: ${path}`);
    }
    return { path, identity };
}

function unchanged(file: WordTimingFile, known?: Map<string, FileIdentity | null>): boolean {
    let identity = known?.get(file.path);
    if (identity === undefined) {
        identity = fileIdentity(file.path);
        known?.set(file.path, identity);
    }
    return identity !== null && wordTimingHash(identity) === wordTimingHash(file.identity);
}

function alignWindow(
    lines: readonly WordTimingLine[],
    words: readonly AsrWordTiming[],
    window: { fromSec: number; toSec: number }
) {
    const selected = lines
        .map((line, index) => ({ line, index }))
        .filter(
            ({ line }) =>
                line.startSec !== undefined &&
                line.endSec !== undefined &&
                line.startSec < window.toSec &&
                line.endSec > window.fromSec
        );
    const aligned = alignWordTimings({ lines: selected.map(({ line }) => line), words, window });
    return { ...aligned, lines: aligned.lines.map((line) => ({ ...line, lineIndex: selected[line.lineIndex].index })) };
}

/** Reading never creates a directory, mutates a file, loads a model or starts inference. */
export class WordTimingCache {
    constructor(readonly folder: string) {}

    private readJson(path: string, budget?: ReadBudget): unknown {
        if (!existsSync(path)) {
            return undefined;
        }
        try {
            const size = statSync(path).size;
            if (size > MAX_CACHE_FILE_BYTES) {
                throw new Error("Word timing cache file exceeds its read budget");
            }
            if (budget) {
                if (size > budget.remaining) {
                    budget.exceeded = true;
                    return undefined;
                }
                budget.remaining -= size;
            }
            return SafeJSON.parse(readFileSync(path, "utf8"), { strict: true });
        } catch (error) {
            log.debug({ error, path }, "Word timing cache entry is unreadable");
            return undefined;
        }
    }

    private current(artifact: WordTimingArtifact, known?: Map<string, FileIdentity | null>): boolean {
        const { id, ...source } = artifact.source;
        return (
            id === wordTimingHash([source, artifact.window, artifact.rawWords]) &&
            artifact.source.runtime.version === STORE_PACKAGES["@huggingface/transformers"] &&
            unchanged(artifact.audio, known) &&
            artifact.modelFiles.every((file) => unchanged(file, known)) &&
            artifact.source.audioFingerprint === wordTimingHash(artifact.audio) &&
            artifact.source.modelFingerprint === wordTimingHash(artifact.modelFiles)
        );
    }

    /** Cheap return-to-window invalidation, including input changes when no event was received. */
    inputRevision(): string | null {
        const manifestPath = join(this.folder, "index.json");
        if (!existsSync(manifestPath)) {
            return wordTimingHash([]);
        }
        const manifest = manifestSchema.safeParse(this.readJson(manifestPath));
        if (!manifest.success) {
            return null;
        }
        const budget: ReadBudget = { remaining: MAX_CACHE_READ_BYTES, exceeded: false };
        const known = new Map<string, FileIdentity | null>();
        const stamps: unknown[] = [fileIdentity(manifestPath)];
        for (const key of new Set(manifest.data.windows)) {
            const path = join(this.folder, `${key}.json`);
            const parsed = artifactSchema.safeParse(this.readJson(path, budget));
            if (!parsed.success || budget.exceeded) {
                return null;
            }
            stamps.push([key, fileIdentity(path), this.current(parsed.data, known)]);
        }
        return wordTimingHash(stamps);
    }

    /** A raw ASR result can be reused after a text correction; its audio/model/window must still match. */
    reusable(
        window: { fromSec: number; toSec: number },
        audio: WordTimingFile,
        modelFiles: WordTimingFile[],
        modelId: string,
        language = "auto"
    ): WordTimingArtifact | undefined {
        const parsed = artifactSchema.safeParse(this.readJson(join(this.folder, `${wordTimingHash(window)}.json`)));
        if (!parsed.success) {
            return undefined;
        }
        const artifact = parsed.data;
        return this.current(artifact) &&
            artifact.source.modelId === modelId &&
            artifact.source.language === language &&
            wordTimingHash(artifact.window) === wordTimingHash(window) &&
            wordTimingHash(artifact.audio) === wordTimingHash(audio) &&
            wordTimingHash(artifact.modelFiles) === wordTimingHash(modelFiles)
            ? artifact
            : undefined;
    }

    read<T extends WordTimingLine>(lines: readonly T[]): WordTimingRead<T> {
        const manifestPath = join(this.folder, "index.json");
        const exists = existsSync(manifestPath);
        const parsed = manifestSchema.safeParse(this.readJson(manifestPath));
        const result: WordTimingRead<T> = {
            entries: lines.map((line) => {
                const clean: T & { words?: TimedTranscriptWord[] } = { ...line };
                delete clean.words;
                return clean;
            }),
            wordTimings: {
                state: exists ? "stale" : "missing",
                revision: wordTimingHash([]),
                windows: [],
                sources: [],
            },
        };
        if (!parsed.success) {
            return result;
        }
        const fingerprint = wordTimingTranscriptFingerprint(lines);
        const artifacts: WordTimingArtifact[] = [];
        const budget: ReadBudget = { remaining: MAX_CACHE_READ_BYTES, exceeded: false };
        const known = new Map<string, FileIdentity | null>();
        for (const key of new Set(parsed.data.windows)) {
            const candidate = artifactSchema.safeParse(this.readJson(join(this.folder, `${key}.json`), budget));
            if (budget.exceeded) {
                log.warn({ folder: this.folder }, "Word timing cache exceeds its aggregate read budget");
                return result;
            }
            if (
                candidate.success &&
                wordTimingHash(candidate.data.window) === key &&
                this.current(candidate.data, known) &&
                candidate.data.transcriptFingerprint === fingerprint
            ) {
                artifacts.push(candidate.data);
            }
        }
        artifacts.sort(
            (a, b) => a.source.generatedAt.localeCompare(b.source.generatedAt) || a.source.id.localeCompare(b.source.id)
        );
        for (const artifact of artifacts) {
            // Re-run the bounded pure policy so corrupt/outdated serialized alignments cannot invent a range.
            let aligned: ReturnType<typeof alignWindow>;
            try {
                aligned = alignWindow(lines, artifact.rawWords, artifact.window);
            } catch (error) {
                log.debug({ error, source: artifact.source.id }, "Invalid cached word timing window ignored");
                continue;
            }
            // A newer window owns each whole line it covers. Mixing only individual matching
            // words can combine contradictory timing sequences from two recognition runs.
            for (const entry of result.entries) {
                if (
                    entry.startSec !== undefined &&
                    entry.endSec !== undefined &&
                    entry.startSec >= artifact.window.fromSec &&
                    entry.endSec <= artifact.window.toSec
                ) {
                    delete entry.words;
                }
            }
            for (const line of aligned.lines) {
                result.entries[line.lineIndex].words = line.words.map((word) => ({
                    ...word,
                    sourceId: artifact.source.id,
                }));
            }
            result.wordTimings.windows.push({ ...artifact.window, coverage: aligned.coverage });
            result.wordTimings.sources.push(artifact.source);
        }
        if (result.wordTimings.sources.length) {
            result.wordTimings.state = "ready";
            result.wordTimings.revision = wordTimingHash([
                fingerprint,
                result.wordTimings.sources.map((source) => source.id),
            ]);
        }
        return result;
    }

    /** Publish one complete window atomically; the manifest is written last. Only explicit generation calls this. */
    async publish(artifact: WordTimingArtifact, signal?: AbortSignal): Promise<void> {
        signal?.throwIfAborted();
        const checked = artifactSchema.parse(artifact);
        if (!this.current(checked)) {
            throw new Error("Word timing inputs changed before publication");
        }
        mkdirSync(this.folder, { recursive: true });
        await withFileLock(join(this.folder, "index.lock"), async () => {
            signal?.throwIfAborted();
            if (!this.current(checked)) {
                throw new Error("Word timing inputs changed before publication");
            }
            const key = wordTimingHash(checked.window);
            const prior = manifestSchema.safeParse(this.readJson(join(this.folder, "index.json")));
            const windows = [...new Set([...(prior.success ? prior.data.windows : []), key])];
            manifestSchema.parse({ version: 1, windows });
            const text = SafeJSON.stringify(checked);
            const bytes =
                Buffer.byteLength(text) +
                windows
                    .filter((other) => other !== key)
                    .reduce((total, other) => total + (fileIdentity(join(this.folder, `${other}.json`))?.size ?? 0), 0);
            if (bytes > MAX_CACHE_READ_BYTES) {
                throw new Error("Word timing cache would exceed its 8 MB read budget");
            }
            atomicWriteFileSync(join(this.folder, `${key}.json`), text);
            atomicWriteFileSync(join(this.folder, "index.json"), SafeJSON.stringify({ version: 1, windows }));
        });
    }
}

export function makeWordTimingArtifact(input: {
    window: { fromSec: number; toSec: number };
    audio: WordTimingFile;
    modelFiles: WordTimingFile[];
    modelId: string;
    language?: string;
    pcmSha256: string;
    words: AsrWordTiming[];
    lines: readonly WordTimingLine[];
    now?: string;
}): WordTimingArtifact {
    // Validate the same bounds before any write, even when the caller only wants the artifact.
    alignWindow(input.lines, input.words, input.window);
    const source = {
        kind: "asr" as const,
        modelId: input.modelId,
        language: input.language ?? "auto",
        runtime: { id: "transformers-js" as const, version: STORE_PACKAGES["@huggingface/transformers"] },
        modelFingerprint: wordTimingHash(input.modelFiles),
        audioFingerprint: wordTimingHash(input.audio),
        generatedAt: input.now ?? new Date().toISOString(),
        policy: "exact-word-v1" as const,
        pcmSha256: input.pcmSha256,
    };
    return artifactSchema.parse({
        version: 2,
        window: input.window,
        audio: input.audio,
        modelFiles: input.modelFiles,
        rawWords: input.words,
        transcriptFingerprint: wordTimingTranscriptFingerprint(input.lines),
        source: { ...source, id: wordTimingHash([source, input.window, input.words]) },
    });
}
