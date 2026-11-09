import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { runVideoCommand } from "@genesiscz/utils/video/process";
import { z } from "zod";
import { recordingItemId } from "./item-ids";
import type { EditProject, OpFacts } from "./project";

/**
 * Voiceover clips and music ducking (round 4, features "voiceover clips" and 8). A voiceover is an extra sound file
 * (a narration made with `tools say`, a recorded take) that plays from a SOURCE time at its own speed, so a cut before
 * it moves it with the picture. The music drops under it, and under the transcript's lines, by `ducking.db`.
 */

/** The cards a voiceover can play over instead of the movie. */
export const VOICEOVER_CARDS = ["intro", "end"] as const;
export type VoiceoverCard = (typeof VOICEOVER_CARDS)[number];

/**
 * One voiceover clip: `file` plays from source time `atUs` for `durationUs` (measured when it was added). With `card`
 * it plays over that card instead: `atUs` then counts from the card's first frame, and the line may run on into what
 * follows the card (the movie after the intro).
 */
export const voiceoverSchema = z.object({
    id: z.string(),
    atUs: z.number().int().nonnegative(),
    card: z.enum(VOICEOVER_CARDS).optional(),
    file: z.string().min(1),
    durationUs: z.number().int().positive(),
    /**
     * How far into the file it starts playing, absent from its beginning; `durationUs` is what plays from there. A part
     * export (partOf) sets it for a line that started before the part, so the part plays the rest of it.
     */
    skipUs: z.number().int().nonnegative().optional(),
    /** 0 to 2 (200 %). */
    volume: z.number().min(0).max(2).default(1),
    /** What it says ("Intro"), for the lists. */
    label: z.string().max(200).optional(),
});
export type EditVoiceover = z.infer<typeof voiceoverSchema>;

/**
 * How far the music drops while someone speaks: `db` quieter (12), reached over `fadeMs` (300), under the transcript's
 * lines and under the voiceover clips (each on by default). Absent keeps the older `music.duck` share, which ducks
 * under both too.
 */
export const duckingSchema = z.object({
    db: z.number().min(0).max(40).default(12),
    fadeMs: z.number().int().min(0).max(5000).default(300),
    transcript: z.boolean().default(true),
    voiceovers: z.boolean().default(true),
});
export type EditDucking = z.infer<typeof duckingSchema>;

/** The extensions a voiceover may have; the renderer reads them with AVFoundation. */
export const VOICEOVER_EXTENSIONS = ["mp3", "wav", "aiff", "aif", "m4a", "caf", "aac"] as const;

/** The length of a sound file, by ffprobe; throws when it has no sound. */
export async function audioFileDurationUs(file: string): Promise<number> {
    const stdout = await runVideoCommand({
        command: [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "format=duration",
            "-of",
            "csv=p=0",
            file,
        ],
        timeoutMs: 30_000,
    });
    const seconds = Number.parseFloat(stdout.trim());

    if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new Error(`${file} has no sound ffprobe can read`);
    }

    return Math.round(seconds * 1_000_000);
}

/** A `voiceover` op with its time in microseconds. */
export interface VoiceoverChange {
    id?: string;
    atUs?: number;
    /** `atUs` counts from this card's start; the clip plays over the card. */
    card?: VoiceoverCard;
    file?: string;
    volume?: number;
    label?: string;
}

/** A voiceover op's file, absolute; refused when it does not exist or is not a sound file. */
export function voiceoverFile(file: string): string {
    const path = resolve(file);

    if (!existsSync(path)) {
        throw new Error(`the voiceover file ${path} does not exist`);
    }

    const extension = path.split(".").pop()?.toLowerCase() ?? "";

    if (!(VOICEOVER_EXTENSIONS as readonly string[]).includes(extension)) {
        throw new Error(`a voiceover is a sound file (${VOICEOVER_EXTENSIONS.join(", ")}), not ${path}`);
    }

    return path;
}

/** Adds a clip, or with `id` changes that clip's time, file, volume or label. `atUs` is already in microseconds. */
export function applyVoiceover(project: EditProject, op: VoiceoverChange, facts: OpFacts): EditProject {
    const list = project.audio.voiceovers ?? [];
    const file = op.file === undefined ? undefined : voiceoverFile(op.file);

    if (file !== undefined && facts.voiceoverDurationUs === undefined) {
        throw new Error(`the length of ${file} was not measured; send the op through apply() or the editor`);
    }

    const index = op.id === undefined ? -1 : list.findIndex((clip) => clip.id === op.id);

    if (op.id !== undefined && index < 0) {
        throw new Error(`no voiceover ${op.id}; voiceovers: ${list.map((clip) => clip.id).join(", ") || "none"}`);
    }

    const card = op.card ?? list[index]?.card;
    const atUs = op.atUs ?? list[index]?.atUs;

    // A card clip's card and time are checked when the op sets them, as a movie clip's time is: a clip whose card went
    // away or got shorter still takes a volume, label or file change, and check() says it does not play.
    if (card !== undefined && (op.card !== undefined || op.atUs !== undefined || op.id === undefined)) {
        const seconds = project.cards?.[card]?.seconds;

        if (seconds === undefined) {
            throw new Error(`there is no ${card} card to speak over; add it first with movie.${card}Card(...)`);
        }

        if (atUs !== undefined && atUs >= Math.round(seconds * 1_000_000)) {
            throw new Error(`a voiceover at ${atUs / 1_000_000} s is past the ${card} card's ${seconds} s`);
        }
    } else if (card === undefined && op.atUs !== undefined && op.atUs >= project.source.durationUs) {
        throw new Error(
            `a voiceover at ${op.atUs / 1_000_000} s starts after the movie's end (${project.source.durationUs / 1_000_000} s)`
        );
    }

    if (op.id !== undefined) {
        const current = list[index];
        const changed = voiceoverSchema.parse({
            ...current,
            ...(op.atUs === undefined ? {} : { atUs: op.atUs }),
            ...(op.card === undefined ? {} : { card: op.card }),
            ...(file === undefined ? {} : { file, durationUs: facts.voiceoverDurationUs }),
            ...(op.volume === undefined ? {} : { volume: op.volume }),
            ...(op.label === undefined ? {} : { label: op.label }),
        });
        const next = list.map((clip, at) => (at === index ? changed : clip));
        return { ...project, audio: { ...project.audio, voiceovers: sortVoiceovers(next) } };
    }

    if (file === undefined || op.atUs === undefined) {
        throw new Error("a new voiceover needs `at` (a source time) and `file` (an mp3, wav or aiff)");
    }

    const clip = voiceoverSchema.parse({
        id: recordingItemId("v"),
        atUs: op.atUs,
        ...(card === undefined ? {} : { card }),
        file,
        durationUs: facts.voiceoverDurationUs,
        ...(op.volume === undefined ? {} : { volume: op.volume }),
        ...(op.label === undefined ? {} : { label: op.label }),
    });
    return { ...project, audio: { ...project.audio, voiceovers: sortVoiceovers([...list, clip]) } };
}

export function removeVoiceover(project: EditProject, id: string): EditProject {
    const list = project.audio.voiceovers ?? [];

    if (!list.some((clip) => clip.id === id)) {
        throw new Error(`no voiceover ${id}; voiceovers: ${list.map((clip) => clip.id).join(", ") || "none"}`);
    }

    const rest = list.filter((clip) => clip.id !== id);
    const { voiceovers: _voiceovers, ...audio } = project.audio;
    return { ...project, audio: rest.length ? { ...audio, voiceovers: rest } : audio };
}

/** `enabled: false` removes the object (the older `music.duck` share applies again). */
export function applyDucking(
    project: EditProject,
    op: { db?: number; fadeMs?: number; transcript?: boolean; voiceovers?: boolean; enabled?: boolean }
): EditProject {
    if (op.enabled === false) {
        const { ducking: _ducking, ...audio } = project.audio;
        return { ...project, audio };
    }

    const { enabled: _enabled, ...change } = op;
    const ducking = duckingSchema.parse({
        ...project.audio.ducking,
        ...Object.fromEntries(Object.entries(change).filter(([, value]) => value !== undefined)),
    });
    return { ...project, audio: { ...project.audio, ducking } };
}

/** The intro card's clips first, then the movie's, then the end card's, each by time. */
function sortVoiceovers(list: EditVoiceover[]): EditVoiceover[] {
    const rank = (clip: EditVoiceover) => (clip.card === "intro" ? 0 : clip.card === "end" ? 2 : 1);
    return [...list].sort((a, b) => rank(a) - rank(b) || a.atUs - b.atUs);
}

/** The music's gain under speech, 0...1: the `ducking` dB when set, else `1 - music.duck`. */
export function duckGain(project: EditProject): number {
    const ducking = project.audio.ducking;

    if (ducking) {
        return 10 ** (-ducking.db / 20);
    }

    return 1 - (project.audio.music?.duck ?? 0);
}

/** What the music drops under, by the renderer's rule (`MusicMix.Duck.of` and `MusicMix.speech`). */
export interface MusicDucking {
    /** The drop is above nothing: the `ducking` dB when set, else the older `music.duck` share. */
    drops: boolean;
    /** It drops under the transcript's lines (when the movie has a transcript): on unless `ducking.transcript` is off. */
    underTranscript: boolean;
    /** It drops under a voiceover clip: the edit has one and `ducking.voiceovers` is not off. */
    underVoiceovers: boolean;
}

/** The one rule check() and describe() use for whether and under what the music ducks. */
export function musicDucking(project: EditProject): MusicDucking {
    const ducking = project.audio.ducking;
    return {
        drops: duckGain(project) < 1,
        underTranscript: ducking?.transcript ?? true,
        underVoiceovers: (ducking?.voiceovers ?? true) && (project.audio.voiceovers?.length ?? 0) > 0,
    };
}
