import { z } from "zod";
import type { EditOp, EditProject, OpFacts } from "./project";

export const AUDIO_LANE_SOURCES = ["mic", "system", "movie", "voiceover", "music"] as const;
export type AudioLaneSource = (typeof AUDIO_LANE_SOURCES)[number];

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
});
export type AudioLane = z.infer<typeof audioLaneSchema>;

export interface AudioFacts {
    movieTracks: number;
    /** The source files mixed into track 0 of a frames proxy. Their offsets are relative to the movie. */
    mixedFrom: Array<{ source: "mic" | "system"; file: string; offsetMs: number }>;
}

function extraLanes(audio: EditProject["audio"]): AudioLane[] {
    const lanes = (audio.voiceovers ?? []).map((clip) =>
        audioLaneSchema.parse({
            id: clip.id,
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
        const input = facts.mixedFrom.find((file) => file.source === source);
        if (input) {
            lanes.push(audioLaneSchema.parse({ ...input, id: source, muted: muted.has(0) }));
        }
    }

    for (let track = lanes.length > 0 ? 1 : 0; track < facts.movieTracks; track++) {
        lanes.push(audioLaneSchema.parse({ id: `movie-${track}`, source: "movie", track, muted: muted.has(track) }));
    }

    return [...lanes, ...extraLanes(audio)];
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

    const overrides = new Map(lanes.map((lane) => [lane.id, lane]));
    const recording = lanes.filter((lane) => lane.source !== "music" && lane.source !== "voiceover");
    const extras = extraLanes(after.audio).map((lane) => overrides.get(lane.id) ?? lane);
    return { ...after, audio: { ...after.audio, lanes: [...recording, ...extras] } };
}

export function setAudioLane(
    project: EditProject,
    op: Extract<EditOp, { op: "audioLane" }>,
    facts: OpFacts
): EditProject {
    let lanes = project.audio.lanes;
    if (lanes === undefined) {
        if (!facts.audioFacts) {
            throw new Error("audioLane needs the recording's sound sources before it can save the first lane mix");
        }

        lanes = audioLanesOf(project, facts.audioFacts);
    }

    const index = lanes.findIndex((lane) => lane.id === op.id);
    if (index < 0) {
        throw new Error(`no audio lane ${op.id}; lanes: ${lanes.map((lane) => lane.id).join(", ") || "none"}`);
    }

    const { op: _op, id: _id, ...change } = op;
    const updated = [...lanes];
    updated[index] = audioLaneSchema.parse({ ...lanes[index], ...change });
    return { ...project, audio: { ...project.audio, lanes: updated } };
}
