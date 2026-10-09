import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync, unlinkSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseSttProvider } from "@genesiscz/utils/ai/stt/resolve";
import type { LiveTranscriptEvent } from "@genesiscz/utils/ai/stt/types";
import { type RecordingEvent, recordPcmClip } from "@genesiscz/utils/ai/voice/record";
import { createVoiceSession, type VoiceEvent } from "@genesiscz/utils/ai/voice/session";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { withFileLock } from "@genesiscz/utils/storage/file-lock";
import { z } from "zod";
import { widgetRoot } from "./storage";

const clipSchema = z.object({
    path: z.string(),
    bytes: z.number().int().positive().max(960_000),
    sampleRateHz: z.literal(16000),
    channels: z.literal(1),
    encoding: z.literal("s16le"),
    durationMs: z.number().positive().max(30_000),
    peakRms: z.number(),
    endedBy: z.enum(["eof", "stop", "limit"]),
    sha256: z.string().length(64),
});
export const voiceNoteSchema = z.object({
    id: z.string().uuid(),
    revision: z.number().int().positive(),
    createdAt: z.number(),
    clip: clipSchema,
    text: z.string().max(64_000),
    recognizedText: z.string().max(64_000),
    transcription: z.enum(["none", "ready", "failed"]),
    error: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    language: z.string().optional(),
    /** The newest transcription attempt; only that attempt may write its outcome. */
    operationId: z.string().uuid().optional(),
});
export type VoiceNote = z.infer<typeof voiceNoteSchema>;
const indexSchema = z.object({ revision: z.number().int().nonnegative(), notes: z.array(voiceNoteSchema).max(100) });
const MAX_METADATA_BYTES = 16 * 1024 * 1024;
type VoiceNoteIndex = z.infer<typeof indexSchema>;
export function voiceNotesDirectory(root?: string): string {
    return join(widgetRoot(root), "voice-notes");
}

async function readIndex(root?: string): Promise<VoiceNoteIndex> {
    const file = Bun.file(join(voiceNotesDirectory(root), "notes.json"));
    if (!(await file.exists())) {
        return { revision: 0, notes: [] };
    }
    if (file.size > MAX_METADATA_BYTES) {
        throw new Error("Voice note metadata exceeds the supported local size");
    }
    return indexSchema.parse(SafeJSON.parse(await file.text()));
}
export async function listVoiceNotes(root?: string) {
    const index = await readIndex(root);
    return {
        ...index,
        notes: index.notes.toSorted((a, b) => b.createdAt - a.createdAt),
        statePath: join(voiceNotesDirectory(root), "notes.json"),
    };
}
async function mutate<T>({
    root,
    signal,
    change,
}: {
    root?: string;
    signal?: AbortSignal;
    change: (index: VoiceNoteIndex) => T;
}): Promise<T> {
    signal?.throwIfAborted();
    const directory = voiceNotesDirectory(root);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return withFileLock(
        join(directory, "notes.lock"),
        async () => {
            signal?.throwIfAborted();
            const index = await readIndex(root);
            const before = SafeJSON.stringify(index);
            const result = change(index);
            if (SafeJSON.stringify(index) === before) {
                return result;
            }
            index.revision++;
            indexSchema.parse(index);
            const serialized = SafeJSON.stringify(index);
            if (Buffer.byteLength(serialized, "utf8") > MAX_METADATA_BYTES) {
                throw new Error("Voice note metadata exceeds the supported local size");
            }

            signal?.throwIfAborted();
            const temporary = join(directory, `notes.${randomUUID()}.tmp`);
            try {
                await writeFile(temporary, serialized, { flag: "wx", mode: 0o600 });
                signal?.throwIfAborted();
                await rename(temporary, join(directory, "notes.json"));
            } catch (error) {
                await unlink(temporary).catch((cleanup) =>
                    logger.debug({ error: cleanup }, "Voice note temporary cleanup")
                );
                throw error;
            }
            return result;
        },
        10_000
    );
}
function noteAt(index: VoiceNoteIndex, id: string): VoiceNote {
    const note = index.notes.find((note) => note.id === id);
    if (!note) {
        throw new Error("This voice note no longer exists");
    }
    return note;
}
export async function readVoiceNote({
    root,
    id,
    expectedRevision,
}: {
    root?: string;
    id: string;
    expectedRevision: number;
}): Promise<VoiceNote> {
    const note = noteAt(await readIndex(root), id);
    expectRevision(note, expectedRevision);
    return note;
}
function expectRevision(note: VoiceNote, revision: number): void {
    if (note.revision !== revision) {
        throw new Error("Voice note changed; reload before saving this revision");
    }
}
function clipPath({ root, note }: { root?: string; note: VoiceNote }): string {
    const expected = resolve(voiceNotesDirectory(root), "clips", `${note.id}.pcm`);
    if (
        resolve(note.clip.path) !== expected ||
        !existsSync(expected) ||
        realpathSync(expected) !== join(realpathSync(voiceNotesDirectory(root)), "clips", `${note.id}.pcm`)
    ) {
        throw new Error("Voice recording is missing or outside its private note storage");
    }
    return expected;
}

export async function recordVoiceNote({
    root,
    id = randomUUID(),
    input = "mic",
    micLauncher,
    signal,
    stopSignal,
    onEvent,
}: {
    root?: string;
    id?: string;
    input?: string;
    micLauncher?: string;
    signal?: AbortSignal;
    stopSignal?: AbortSignal;
    onEvent?: (event: RecordingEvent) => void;
}): Promise<VoiceNote> {
    z.string().uuid().parse(id);
    const current = await readIndex(root);
    if (current.notes.length >= 100) {
        throw new Error("The local voice notebook is full. Discard a note before recording another.");
    }
    if (current.notes.some((note) => note.id === id)) {
        throw new Error("This voice note already exists");
    }
    const output = join(voiceNotesDirectory(root), "clips", `${id}.pcm`);
    const clip = await recordPcmClip({
        output,
        input,
        micLauncher,
        maxDurationMs: 30_000,
        signal,
        stopSignal,
        onEvent,
    });
    const sha256 = createHash("sha256")
        .update(new Uint8Array(await Bun.file(output).arrayBuffer()))
        .digest("hex");
    const note = voiceNoteSchema.parse({
        id,
        revision: 1,
        createdAt: Date.now(),
        clip: { ...clip, sha256 },
        text: "",
        recognizedText: "",
        transcription: "none",
    });
    let duplicate = false;
    try {
        return await mutate({
            root,
            signal,
            change: (index) => {
                if (index.notes.some((entry) => entry.id === id)) {
                    duplicate = true;
                    throw new Error("This voice note already exists");
                }

                if (index.notes.length >= 100) {
                    throw new Error("The local voice notebook is full. Discard a note before recording another.");
                }

                index.notes.push(note);
                return note;
            },
        });
    } catch (error) {
        // A duplicate id owns this clip path, so only a clip no note refers to is removed.
        if (duplicate) {
            throw error;
        }

        await unlink(output).catch((cleanup) =>
            logger.debug({ error: cleanup, id }, "Unsaved voice recording cleanup")
        );
        if (signal?.aborted) {
            throw error;
        }

        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`The recording was discarded because it could not be saved: ${reason}`, { cause: error });
    }
}
export async function editVoiceNote({
    root,
    id,
    expectedRevision,
    text,
    signal,
}: {
    root?: string;
    id: string;
    expectedRevision: number;
    text: string;
    signal?: AbortSignal;
}): Promise<VoiceNote> {
    const edited = z.string().max(64_000).parse(text);
    return mutate({
        root,
        signal,
        change: (index) => {
            const note = noteAt(index, id);
            expectRevision(note, expectedRevision);
            if (note.text !== edited) {
                note.text = edited;
                note.revision++;
            }
            return note;
        },
    });
}
export async function transcribeVoiceNote({
    root,
    id,
    expectedRevision,
    provider,
    account,
    model,
    language,
    signal,
    events,
    onEvent = () => {},
    createSession = createVoiceSession,
}: {
    root?: string;
    id: string;
    expectedRevision: number;
    provider: string;
    account?: string;
    model?: string;
    language?: string;
    signal?: AbortSignal;
    events?: LiveTranscriptEvent[];
    onEvent?: (event: VoiceEvent) => void;
    createSession?: typeof createVoiceSession;
}): Promise<VoiceNote> {
    signal?.throwIfAborted();
    const original = noteAt(await readIndex(root), id);
    expectRevision(original, expectedRevision);
    const file = clipPath({ root, note: original });
    const audio = Bun.file(file);
    if (
        audio.size !== original.clip.bytes ||
        audio.size > 960_000 ||
        createHash("sha256")
            .update(new Uint8Array(await audio.arrayBuffer()))
            .digest("hex") !== original.clip.sha256
    ) {
        throw new Error("The saved audio changed; transcription was not started");
    }
    const resolvedProvider = parseSttProvider(provider);
    if (events && resolvedProvider !== "fixture") {
        throw new Error("Synthetic events require the fixture speech provider");
    }

    const operationId = randomUUID();
    await mutate({
        root,
        signal,
        change: (index) => {
            const note = noteAt(index, id);
            expectRevision(note, expectedRevision);
            note.operationId = operationId;
        },
    });
    try {
        const session = await createSession({
            provider: resolvedProvider,
            account,
            model,
            languages: language
                ? language
                      .split(",")
                      .map((entry) => entry.trim())
                      .filter(Boolean)
                : undefined,
            input: file,
            sampleRateHz: 16000,
            realtime: resolvedProvider !== "fixture",
            maxDurationMs: 33_000,
            signal,
            events,
            onEvent,
        });
        const text = (await session.done).trim();
        signal?.throwIfAborted();
        if (!text) {
            throw new Error("No speech was recognized. Your recording is kept for retry.");
        }
        return await mutate({
            root,
            signal,
            change: (index) => {
                const note = noteAt(index, id);
                if (note.operationId !== operationId) {
                    return note;
                }

                note.operationId = undefined;
                if (note.revision === expectedRevision) {
                    note.text = text;
                }
                note.recognizedText = text;
                note.transcription = "ready";
                note.error = undefined;
                note.provider = resolvedProvider;
                note.model = model;
                note.language = language;
                note.revision++;
                return note;
            },
        });
    } catch (error) {
        signal?.throwIfAborted();
        try {
            await mutate({
                root,
                change: (index) => {
                    const note = noteAt(index, id);
                    if (note.operationId !== operationId) {
                        return;
                    }

                    note.operationId = undefined;
                    note.transcription = "failed";
                    note.error = error instanceof Error ? error.message : String(error);
                    note.revision++;
                },
            });
        } catch (recordError) {
            // The note may have been discarded meanwhile; the provider failure stays the reported error.
            logger.warn({ error: recordError, id }, "Could not record the transcription failure on the voice note");
        }

        throw error;
    }
}
export async function discardVoiceNote({
    root,
    id,
    expectedRevision,
    signal,
}: {
    root?: string;
    id: string;
    expectedRevision: number;
    signal?: AbortSignal;
}) {
    await mutate({
        root,
        signal,
        change: (index) => {
            const note = noteAt(index, id);
            expectRevision(note, expectedRevision);
            const expected = resolve(voiceNotesDirectory(root), "clips", `${note.id}.pcm`);
            if (resolve(note.clip.path) !== expected) {
                throw new Error("Voice recording is outside its private note storage");
            }

            // A clip deleted outside the tool must not pin its note forever; an existing one is fully checked.
            if (existsSync(expected)) {
                clipPath({ root, note });
            }

            // The clip goes first: a failed unlink keeps the note listed so a retry can still reach it.
            try {
                unlinkSync(expected);
            } catch (error) {
                if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
                    throw error;
                }

                logger.debug({ error, id }, "Discarded voice note had no clip file left");
            }

            index.notes = index.notes.filter((entry) => entry.id !== id);
        },
    });

    return { discarded: true, id };
}
