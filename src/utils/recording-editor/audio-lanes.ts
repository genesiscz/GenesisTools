import { createHash } from "node:crypto";
import { z } from "zod";
import { recordingItemId } from "./item-ids";
import type { EditOp, EditProject, OpFacts } from "./project";

export const AUDIO_LANE_SOURCES = ["mic", "system", "movie", "voiceover", "music"] as const;
export type AudioLaneSource = (typeof AUDIO_LANE_SOURCES)[number];

/** A part of one lane that the mix plays silent (a cough, a doorbell), on the source clock like every edit range. */
export const audioMutedRangeSchema = z
    .object({
        id: z.string().min(1),
        startUs: z.number().int().nonnegative(),
        endUs: z.number().int().positive(),
    })
    .refine((range) => range.endUs > range.startUs, "A muted part ends after it starts");
export type AudioMutedRange = z.infer<typeof audioMutedRangeSchema>;

/** A new muted part's id ("u" for unheard, like "k" for a camera part). */
export function audioMutedRangeId(): string {
    return recordingItemId("u");
}

/** A recording file beside the movie, a track inside it, or the mix settings of a voiceover or music bed. */
export const audioLaneSchema = z.object({
    id: z.string().min(1).max(40),
    source: z.enum(AUDIO_LANE_SOURCES),
    file: z.string().min(1).optional(),
    track: z.number().int().nonnegative().optional(),
    offsetMs: z.number().int().min(-600_000).max(600_000).default(0),
    muted: z.boolean().default(false),
    volume: z.number().min(0).max(2).default(1),
    name: z.string().max(40).optional(),
    /** Parts the mix plays silent, in start order; absent when the whole lane plays (`muted` silences all of it). */
    mutedRanges: z.array(audioMutedRangeSchema).optional(),
});
export type AudioLane = z.infer<typeof audioLaneSchema>;
export const audioLanesSchema = z
    .array(audioLaneSchema)
    .refine((lanes) => new Set(lanes.map((lane) => lane.id)).size === lanes.length, "Audio lane IDs must be unique");

/** What a recording's sound is made of, measured once per open; the lanes of an edit that never saved them come from it. */
export const audioFactsSchema = z.object({
    movieTracks: z.number().int().nonnegative(),
    /** The source files mixed into track 0 of a frames proxy. Their offsets are relative to the movie. */
    mixedFrom: z.array(z.object({ source: z.enum(["mic", "system"]), file: z.string(), offsetMs: z.number() })),
});
export type AudioFacts = z.infer<typeof audioFactsSchema>;

function voiceoverLaneId(id: string): string {
    // Ordinary clip IDs keep their saved lane identity. Disambiguate reserved recording and music IDs.
    if (
        id.length > 0 &&
        id.length <= 40 &&
        !/^(?:(?:mic|system)(?:-\d+)?|music|movie-\d+|voice-[0-9a-f]{32})$/.test(id)
    ) {
        return id;
    }
    return `voice-${createHash("sha256").update(id).digest("hex").slice(0, 32)}`;
}

function extraLanes(audio: EditProject["audio"]): AudioLane[] {
    const lanes = (audio.voiceovers ?? []).map((clip) =>
        audioLaneSchema.parse({
            id: voiceoverLaneId(clip.id),
            source: "voiceover",
            ...(clip.label ? { name: clip.label.slice(0, 40) } : {}),
        })
    );

    if (audio.music) {
        lanes.push(audioLaneSchema.parse({ id: "music", source: "music" }));
    }

    return lanes;
}

/** Deriving lanes is read-only. Opening an old project never materializes them in its edit file. */
export function audioLanesOf(project: EditProject, facts: AudioFacts): AudioLane[] {
    const audio = project.audio;
    if (audio.lanes !== undefined) {
        return audio.lanes;
    }

    const muted = new Set(audio.mutedTracks);
    const lanes: AudioLane[] = [];
    for (const source of ["mic", "system"] as const) {
        const inputs = facts.mixedFrom.filter((file) => file.source === source);
        for (const [index, input] of inputs.entries()) {
            const id = index === 0 ? source : `${source}-${index + 1}`;
            const name =
                inputs.length > 1 ? `${source === "mic" ? "Microphone" : "System sound"} ${index + 1}` : undefined;
            lanes.push(audioLaneSchema.parse({ ...input, id, name, muted: muted.has(0) }));
        }
    }

    for (let track = lanes.length > 0 ? 1 : 0; track < facts.movieTracks; track++) {
        lanes.push(audioLaneSchema.parse({ id: `movie-${track}`, source: "movie", track, muted: muted.has(track) }));
    }

    return audioLanesSchema.parse([...lanes, ...extraLanes(audio)]);
}

/** A replacement file suppresses its proxy mix even when the file lane itself is muted. */
export function movieTracksPlayed(lanes: readonly AudioLane[], facts: AudioFacts): number[] {
    const excluded = new Set<number>();
    for (const lane of lanes) {
        if (lane.file && facts.mixedFrom.some((input) => input.source === lane.source)) {
            excluded.add(0);
        } else if (!lane.file && lane.track !== undefined && lane.muted) {
            excluded.add(lane.track);
        }
    }

    return Array.from({ length: facts.movieTracks }, (_, track) => track).filter((track) => !excluded.has(track));
}

/** The existing music and voiceover ops can add or remove a source after the lane mix was first saved. */
export function syncExtraAudioLanes(before: EditProject, after: EditProject): EditProject {
    const lanes = after.audio.lanes;
    if (!lanes || (before.audio.voiceovers === after.audio.voiceovers && before.audio.music === after.audio.music)) {
        return after;
    }

    const overrides = new Map(lanes.map((lane) => [`${lane.source}:${lane.id}`, lane]));
    // An old ID can be another clip's current lane ID. In that case the current owner keeps its controls.
    const clips = before.audio.voiceovers ?? [];
    const currentVoiceovers = new Set(clips.map((clip) => voiceoverLaneId(clip.id)));
    for (const clip of clips) {
        if (currentVoiceovers.has(clip.id)) {
            continue;
        }
        const old = overrides.get(`voiceover:${clip.id}`);
        const key = `voiceover:${voiceoverLaneId(clip.id)}`;
        if (old && !overrides.has(key)) {
            overrides.set(key, old);
        }
    }
    const recording = lanes.filter((lane) => lane.source !== "music" && lane.source !== "voiceover");
    const extras = extraLanes(after.audio).map((lane) => {
        const override = overrides.get(`${lane.source}:${lane.id}`);
        return override
            ? { ...lane, volume: override.volume, muted: override.muted, name: override.name ?? lane.name }
            : lane;
    });
    return { ...after, audio: { ...after.audio, lanes: audioLanesSchema.parse([...recording, ...extras]) } };
}

/**
 * The edit with lane `id` changed by `change`. The first lane edit writes every derived lane once (`audioLanesOf`),
 * so it needs the recording's sound sources.
 */
function withLane(options: {
    project: EditProject;
    id: string;
    facts: OpFacts;
    opName: string;
    change: (lane: AudioLane) => AudioLane;
}): EditProject {
    const { project, id, facts, opName, change } = options;
    let lanes = project.audio.lanes;
    if (lanes === undefined) {
        if (!facts.audioFacts) {
            throw new Error(`${opName} needs the recording's sound sources before it can save the first lane mix`);
        }

        lanes = audioLanesOf(project, facts.audioFacts);
    }

    const index = lanes.findIndex((lane) => lane.id === id);
    if (index < 0) {
        throw new Error(`no audio lane ${id}; lanes: ${lanes.map((lane) => lane.id).join(", ") || "none"}`);
    }

    const updated = [...lanes];
    updated[index] = audioLaneSchema.parse(change(lanes[index]));
    return { ...project, audio: { ...project.audio, lanes: updated } };
}

export function setAudioLane(
    project: EditProject,
    op: Extract<EditOp, { op: "audioLane" }>,
    facts: OpFacts
): EditProject {
    const { op: _op, id, ...change } = op;
    return withLane({ project, id, facts, opName: "audioLane", change: (lane) => ({ ...lane, ...change }) });
}

/** Mutes `fromUs` to `toUs` of lane `id` as a part of its own, in start order; an overlapping part keeps its id. */
export function muteAudioLaneRange(options: {
    project: EditProject;
    id: string;
    fromUs: number;
    toUs: number;
    facts: OpFacts;
}): EditProject {
    const { project, id, fromUs, toUs, facts } = options;
    if (toUs <= fromUs) {
        throw new RangeError(`a muted part needs its end after its start (got ${fromUs / 1e6}–${toUs / 1e6} s)`);
    }

    const part = { id: audioMutedRangeId(), startUs: fromUs, endUs: toUs };
    return withLane({
        project,
        id,
        facts,
        opName: "audioMute",
        change: (lane) => ({
            ...lane,
            mutedRanges: [...(lane.mutedRanges ?? []), part].sort((a, b) => a.startUs - b.startUs),
        }),
    });
}

/**
 * Lane `id` plays again over `fromUs` to `toUs` (a part may split in two; the part after a split gets a new id), or
 * loses the one muted part `part`. A lane with no muted part left drops the field.
 */
export function unmuteAudioLaneRange(options: {
    project: EditProject;
    id: string;
    facts: OpFacts;
    range?: { fromUs: number; toUs: number };
    part?: string;
}): EditProject {
    const { project, id, facts, range, part } = options;
    return withLane({
        project,
        id,
        facts,
        opName: "audioUnmute",
        change: (lane) => {
            const before = lane.mutedRanges ?? [];
            let after: AudioMutedRange[];
            if (part !== undefined) {
                after = before.filter((one) => one.id !== part);
                if (after.length === before.length) {
                    throw new Error(
                        `lane ${id} has no muted part ${part}; parts: ${before.map((one) => one.id).join(", ") || "none"}`
                    );
                }
            } else if (range) {
                after = before.flatMap((one) => {
                    if (one.endUs <= range.fromUs || one.startUs >= range.toUs) {
                        return [one];
                    }

                    const head = one.startUs < range.fromUs ? [{ ...one, endUs: range.fromUs }] : [];
                    const tail =
                        one.endUs > range.toUs
                            ? [{ ...one, id: head.length ? audioMutedRangeId() : one.id, startUs: range.toUs }]
                            : [];
                    return [...head, ...tail];
                });
            } else {
                throw new RangeError("audioUnmute takes a part id or a from and to range");
            }

            const { mutedRanges: _old, ...rest } = lane;
            return after.length ? { ...rest, mutedRanges: after } : rest;
        },
    });
}
