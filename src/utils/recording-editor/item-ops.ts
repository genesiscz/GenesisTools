import { cameraHiddenId } from "./camera";
import { denoiseSchema } from "./denoise";
import type { CursorSample, EditOp, EditProject } from "./project";
import { MINIMUM_CLIP_US, newId, placeZoom } from "./project";

/**
 * The ops that change an item that exists (a zoom, hidden part, text, shape, clip or lane) by its id, as the editor
 * window's controls and drags do. Each one holds the values inside their ranges the way the window did (a drag past
 * the picture's edge stops at the edge) instead of refusing them, so a drag never fails half way.
 */

type Op<K extends EditOp["op"]> = Extract<EditOp, { op: K }>;

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/** A spotlight's dim that equals the default is not written (the window's rule). */
const SPOTLIGHT_DIM = 0.7;

/** The shortest a hidden part, text, shape or camera part may last. */
const MINIMUM_ITEM_US = 100_000;

function missing(kind: string, id: string, ids: readonly string[]): Error {
    return new Error(`no ${kind} ${id}; ${kind}s: ${ids.join(", ") || "none"}`);
}

export function setZoom(project: EditProject, op: Op<"setZoom">): EditProject {
    const index = project.zooms.findIndex((zoom) => zoom.id === op.id);

    if (index < 0) {
        throw missing(
            "zoom",
            op.id,
            project.zooms.map((zoom) => zoom.id)
        );
    }

    const zoom = project.zooms[index];
    // Placing the focus by hand makes a zoom that followed the cursor a manual one, unless the op names the mode.
    const mode = op.mode ?? (op.focus ? "manual" : zoom.mode);
    const next = {
        ...zoom,
        mode,
        ...(op.scale === undefined ? {} : { scale: clamp(op.scale, 1, 4) }),
        ...(op.focus ? { focusX: clamp(op.focus.x, 0, 1), focusY: clamp(op.focus.y, 0, 1) } : {}),
        ...(op.easeInMs === undefined ? {} : { easeInMs: Math.round(clamp(op.easeInMs, 0, 5000)) }),
        ...(op.easeOutMs === undefined ? {} : { easeOutMs: Math.round(clamp(op.easeOutMs, 0, 5000)) }),
    };
    return { ...project, zooms: project.zooms.map((item, at) => (at === index ? next : item)) };
}

export function setRedaction(project: EditProject, op: Op<"setRedaction">): EditProject {
    const list = project.redactions ?? [];
    const item = list.find((redaction) => redaction.id === op.id);

    if (!item) {
        throw missing(
            "hidden part",
            op.id,
            list.map((redaction) => redaction.id)
        );
    }

    const rect = op.rect ?? { x: item.x, y: item.y, width: item.width, height: item.height };
    const width = clamp(rect.width, 0.01, 1);
    const height = clamp(rect.height, 0.01, 1);
    const { label: oldLabel, follow: oldFollow, dim: oldDim, cutout: oldCutout, ...rest } = item;
    const label = op.label === undefined ? oldLabel : op.label.trim().slice(0, 60) || undefined;
    const follow = op.follow === undefined ? oldFollow : op.follow || undefined;
    const dim =
        op.dim === undefined ? oldDim : Math.abs(op.dim - SPOTLIGHT_DIM) < 0.005 ? undefined : clamp(op.dim, 0.2, 0.95);
    const cutout = op.cutout ?? oldCutout;
    const next = {
        ...rest,
        x: clamp(rect.x, 0, 1 - width),
        y: clamp(rect.y, 0, 1 - height),
        width,
        height,
        ...(op.style ? { style: op.style } : {}),
        ...(label === undefined ? {} : { label }),
        ...(follow === undefined ? {} : { follow }),
        ...(dim === undefined ? {} : { dim }),
        ...(cutout === undefined ? {} : { cutout }),
    };
    return { ...project, redactions: list.map((redaction) => (redaction.id === op.id ? next : redaction)) };
}

export function setText(project: EditProject, op: Op<"setText">): EditProject {
    const list = project.texts ?? [];
    const item = list.find((note) => note.id === op.id);

    if (!item) {
        throw missing(
            "text",
            op.id,
            list.map((note) => note.id)
        );
    }

    const text = op.text === undefined ? item.text : op.text.trim().slice(0, 200);

    if (!text) {
        throw new RangeError("a text needs words; delete it with untext instead");
    }

    const next = {
        ...item,
        text,
        ...(op.x === undefined ? {} : { x: clamp(op.x, 0, 1) }),
        ...(op.y === undefined ? {} : { y: clamp(op.y, 0, 1) }),
        ...(op.size === undefined ? {} : { size: clamp(op.size, 0.02, 0.15) }),
        ...(op.style ? { style: op.style } : {}),
    };
    return { ...project, texts: list.map((note) => (note.id === op.id ? next : note)) };
}

export function setShape(project: EditProject, op: Op<"setShape">): EditProject {
    const list = project.shapes ?? [];
    const item = list.find((shape) => shape.id === op.id);

    if (!item) {
        throw missing(
            "shape",
            op.id,
            list.map((shape) => shape.id)
        );
    }

    const { appear: oldAppear, ...rest } = item;
    const appear = op.appear === undefined ? oldAppear : op.appear === "draw" ? undefined : op.appear;
    const next = {
        ...rest,
        ...(op.kind ? { kind: op.kind } : {}),
        ...(op.start ? { x1: clamp(op.start.x, 0, 1), y1: clamp(op.start.y, 0, 1) } : {}),
        ...(op.end ? { x2: clamp(op.end.x, 0, 1), y2: clamp(op.end.y, 0, 1) } : {}),
        ...(op.color ? { color: op.color.toUpperCase() } : {}),
        ...(op.width === undefined ? {} : { width: clamp(op.width, 0.002, 0.03) }),
        ...(appear === undefined ? {} : { appear }),
    };
    return { ...project, shapes: list.map((shape) => (shape.id === op.id ? next : shape)) };
}

function clipIndex(project: EditProject, id: string): number {
    const index = project.clips.findIndex((clip) => clip.id === id);

    if (index < 0) {
        throw missing(
            "clip",
            id,
            project.clips.map((clip) => clip.id)
        );
    }

    return index;
}

/** Moves a clip's edges (source µs): held inside the movie and at least one frame long, as a drag of its edge is. */
export function trimClip(project: EditProject, op: { clip: string; fromUs?: number; toUs?: number }): EditProject {
    const index = clipIndex(project, op.clip);
    const clip = { ...project.clips[index] };

    if (op.fromUs !== undefined) {
        clip.fromUs = Math.max(0, Math.min(op.fromUs, clip.toUs - MINIMUM_CLIP_US));
    }

    if (op.toUs !== undefined) {
        clip.toUs = Math.min(project.source.durationUs, Math.max(op.toUs, clip.fromUs + MINIMUM_CLIP_US));
    }

    return { ...project, clips: project.clips.map((each, at) => (at === index ? clip : each)) };
}

export function deleteClip(project: EditProject, id: string): EditProject {
    const index = clipIndex(project, id);

    if (project.clips.length === 1) {
        throw new RangeError("the last clip cannot be deleted");
    }

    return { ...project, clips: project.clips.filter((_, at) => at !== index) };
}

export function clipSpeed(project: EditProject, op: Op<"clipSpeed">): EditProject {
    const index = clipIndex(project, op.clip);
    const speed = clamp(op.factor, 0.25, 16);
    return { ...project, clips: project.clips.map((clip, at) => (at === index ? { ...clip, speed } : clip)) };
}

/** A copy of an item right after it, with a new id; a zoom's copy goes after any zoom it would meet. */
export function duplicateItem(project: EditProject, id: string): EditProject {
    const durationUs = project.source.durationUs;
    const after = <T extends { id: string; startUs: number; endUs: number }>(item: T, newItemId: string): T => {
        const length = item.endUs - item.startUs;
        const startUs = Math.min(item.endUs, durationUs - MINIMUM_ITEM_US);
        return { ...item, id: newItemId, startUs, endUs: Math.min(durationUs, startUs + length) };
    };

    const zoom = project.zooms.find((item) => item.id === id);

    if (zoom) {
        const span = placeZoom(project, zoom.endUs, zoom.endUs + (zoom.endUs - zoom.startUs));

        if (!span) {
            throw new RangeError("no room after this zoom for a copy; zooms cannot overlap");
        }

        const zooms = [...project.zooms, { ...zoom, id: newId("z"), ...span }].sort((a, b) => a.startUs - b.startUs);
        return { ...project, zooms };
    }

    const redaction = project.redactions?.find((item) => item.id === id);

    if (redaction) {
        return { ...project, redactions: [...(project.redactions ?? []), after(redaction, newId("r"))] };
    }

    const text = project.texts?.find((item) => item.id === id);

    if (text) {
        return { ...project, texts: [...(project.texts ?? []), after(text, newId("t"))] };
    }

    const shape = project.shapes?.find((item) => item.id === id);

    if (shape) {
        return { ...project, shapes: [...(project.shapes ?? []), after(shape, newId("s"))] };
    }

    const hidden = project.camera?.hidden.find((item) => item.id === id);

    if (project.camera && hidden) {
        const copy = after(hidden, cameraHiddenId());
        return {
            ...project,
            camera: {
                ...project.camera,
                hidden: [...project.camera.hidden, copy].sort((a, b) => a.startUs - b.startUs),
            },
        };
    }

    throw new Error(`no zoom, hidden part, text, shape or camera part ${id} to duplicate`);
}

/** The circles Circle Every Click made: a circle that starts within 0.1 s of a recorded click. */
export function clickCircleIds(project: EditProject, samples: readonly CursorSample[]): Set<string> {
    const clicks = samples.filter((sample) => sample.click).map((sample) => Math.round(sample.ms * 1000));
    return new Set(
        (project.shapes ?? [])
            .filter((shape) => shape.kind === "circle" && clicks.some((us) => Math.abs(us - shape.startUs) <= 100_000))
            .map((shape) => shape.id)
    );
}

export function removeClickCircles(project: EditProject, samples: readonly CursorSample[]): EditProject {
    const ids = clickCircleIds(project, samples);

    if (ids.size === 0) {
        throw new RangeError("there is no click circle to remove (a circle that starts at a recorded click)");
    }

    const rest = (project.shapes ?? []).filter((shape) => !ids.has(shape.id));
    const { shapes: _shapes, ...without } = project;
    return rest.length ? { ...project, shapes: rest } : without;
}

/** Deletes a camera-hidden part by its id. */
export function removeCameraHidden(project: EditProject, id: string): EditProject {
    const hidden = project.camera?.hidden ?? [];

    if (!project.camera || !hidden.some((item) => item.id === id)) {
        throw missing(
            "camera part",
            id,
            hidden.map((item) => item.id)
        );
    }

    return { ...project, camera: { ...project.camera, hidden: hidden.filter((item) => item.id !== id) } };
}

/**
 * Where a new shape goes when the op gives no points: at `at`, else where the pointer is at its start (the cursor
 * track), else the middle. An arrow points at it from towards the middle; a box or circle goes round it.
 */
export function placedShape(
    kind: "arrow" | "box" | "circle",
    at: { x: number; y: number }
): { start: { x: number; y: number }; end: { x: number; y: number } } {
    const unit = (value: number) => clamp(value, 0, 1);

    if (kind === "arrow") {
        const toward = { x: at.x > 0.5 ? -1 : 1, y: at.y > 0.5 ? -1 : 1 };
        return {
            start: { x: unit(at.x + toward.x * 0.09), y: unit(at.y + toward.y * 0.09) },
            end: { x: at.x, y: at.y },
        };
    }

    return {
        start: { x: unit(at.x - 0.08), y: unit(at.y - 0.06) },
        end: { x: unit(at.x + 0.08), y: unit(at.y + 0.06) },
    };
}

/**
 * The pointer's place at a moment of the cursor track (the window's `CursorTrack.point`): between two samples it
 * moves over the last 16.7 ms before the later one.
 */
export function cursorPointAt(samples: readonly CursorSample[], ms: number): { x: number; y: number } | undefined {
    if (samples.length === 0) {
        return undefined;
    }

    const next = samples.findIndex((sample) => sample.ms >= ms);

    if (next === 0) {
        return { x: samples[0].x, y: samples[0].y };
    }

    if (next < 0) {
        const last = samples[samples.length - 1];
        return { x: last.x, y: last.y };
    }

    const a = samples[next - 1];
    const b = samples[next];
    const start = Math.max(a.ms, b.ms - 16.7);

    if (!(ms > start && b.ms > start)) {
        return { x: a.x, y: a.y };
    }

    const f = (ms - start) / (b.ms - start);
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}

/**
 * One track's noise reduction, the editor's Audio tab rules: a track in or out of the cleaned tracks (every track is
 * no list, no track left is off), or a track's own strength in whole dB (with one track it is the base strength, and a
 * strength equal to the base is not written). Turning a track on turns the sound on.
 */
export function denoiseTrack(project: EditProject, op: Op<"denoise">): EditProject {
    const track = op.track ?? 0;
    const count = Math.max(1, op.trackCount ?? 1);
    const settings = denoiseSchema.parse({ ...project.audio.denoise });
    const audio = { ...project.audio, include: true };

    if (op.on !== undefined) {
        const tracks = new Set(
            project.audio.denoise ? (settings.tracks ?? Array.from({ length: count }, (_, index) => index)) : []
        );

        if (op.on) {
            tracks.add(track);
        } else {
            tracks.delete(track);
        }

        if (tracks.size === 0) {
            const { denoise: _denoise, ...rest } = audio;
            return { ...project, audio: rest };
        }

        const every = Array.from({ length: count }, (_, index) => index).every((index) => tracks.has(index));
        const { tracks: _tracks, ...rest } = settings;
        const denoise = every ? rest : { ...rest, tracks: [...tracks].sort((a, b) => a - b) };
        return { ...project, audio: { ...audio, denoise } };
    }

    if (op.reductionDb === undefined) {
        throw new RangeError("a denoise op with a track needs on or reductionDb");
    }

    const db = clamp(Math.round(op.reductionDb), 1, 40);

    if (count <= 1) {
        return { ...project, audio: { ...audio, denoise: { ...settings, reductionDb: db } } };
    }

    const { [String(track)]: _old, ...others } = settings.trackReductionDb ?? {};
    const map = db === settings.reductionDb ? others : { ...others, [String(track)]: db };
    const { trackReductionDb: _map, ...rest } = settings;
    const denoise = Object.keys(map).length ? { ...rest, trackReductionDb: map } : rest;
    return { ...project, audio: { ...audio, denoise } };
}
