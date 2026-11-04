import { z } from "zod";
import type { EditProject } from "./project";

/**
 * The effect lanes of the editor's timeline (EffectLanes.swift is the window's copy of this file). Every item over the
 * picture for a time is one kind; a clip played at another speed shows as a `speed` item on a lane that holds speed.
 */
export const EFFECT_KINDS = ["zoom", "hide", "spotlight", "text", "shape", "speed", "cameraHide"] as const;
export type EffectKind = (typeof EFFECT_KINDS)[number];

/** The kinds a lane made for one kind holds as well: a hidden part and a spotlight share a lane by default. */
const FAMILY: Record<EffectKind, EffectKind[]> = {
    zoom: ["zoom"],
    hide: ["hide", "spotlight"],
    spotlight: ["hide", "spotlight"],
    text: ["text", "shape"],
    shape: ["text", "shape"],
    speed: ["speed"],
    /** A part where the camera bubble is not drawn (camera.ts). */
    cameraHide: ["cameraHide"],
};

/** One lane: what it holds (absent holds every kind) and its name (absent names what it holds). */
export const effectLaneSchema = z.object({
    id: z.string().min(1).max(40),
    kinds: z.array(z.enum(EFFECT_KINDS)).min(1).optional(),
    name: z.string().max(40).optional(),
});
export type EffectLane = z.infer<typeof effectLaneSchema>;

/** The lanes of an edit that never saved its own: the zoom lane. The others appear when they get an item. */
export const DEFAULT_LANES: readonly EffectLane[] = [{ id: "zooms", kinds: ["zoom"] }];

export interface LaneItem {
    id: string;
    kind: EffectKind;
    startUs: number;
    endUs: number;
    /** The lane the item asked for; absent goes to the first lane that holds its kind. */
    lane?: string;
}

export interface ResolvedLane {
    lane: EffectLane;
    items: LaneItem[];
    /** Not in edit.json: made because an item had no lane that holds its kind. */
    automatic: boolean;
}

function holds(lane: EffectLane, kind: EffectKind): boolean {
    return lane.kinds ? lane.kinds.includes(kind) : true;
}

/** Every item of the edit as a lane item, in time order. */
export function laneItems(project: EditProject): LaneItem[] {
    const items: LaneItem[] = [
        ...project.zooms.map((zoom) => ({ ...span(zoom), kind: "zoom" as const })),
        ...(project.redactions ?? []).map((redaction) => ({
            ...span(redaction),
            kind: redaction.style === "spotlight" ? ("spotlight" as const) : ("hide" as const),
        })),
        ...(project.texts ?? []).map((note) => ({ ...span(note), kind: "text" as const })),
        ...(project.shapes ?? []).map((shape) => ({ ...span(shape), kind: "shape" as const })),
        ...(project.camera?.hidden ?? []).map((range) => ({ ...span(range), kind: "cameraHide" as const })),
        ...project.clips
            .filter((clip) => clip.speed !== 1)
            .map((clip) => ({ id: clip.id, kind: "speed" as const, startUs: clip.fromUs, endUs: clip.toUs })),
    ];
    return items.sort((a, b) => a.startUs - b.startUs || a.id.localeCompare(b.id));
}

function span(item: { id: string; startUs: number; endUs: number; lane?: string }) {
    return { id: item.id, startUs: item.startUs, endUs: item.endUs, ...(item.lane ? { lane: item.lane } : {}) };
}

/**
 * The lanes in order with their items, as the editor draws them. An item goes to the lane it names when that lane
 * holds its kind, else to the first lane that does; with none, a lane for its family is added at the end (a speed item
 * has the clip lane's badge, so it never makes one).
 */
export function resolveLanes(project: EditProject): ResolvedLane[] {
    const resolved: ResolvedLane[] = (project.lanes ?? DEFAULT_LANES).map((lane) => ({
        lane,
        items: [],
        automatic: false,
    }));

    for (const item of laneItems(project)) {
        const target =
            resolved.find((entry) => entry.lane.id === item.lane && holds(entry.lane, item.kind)) ??
            resolved.find((entry) => holds(entry.lane, item.kind));

        if (target) {
            target.items.push(item);
        } else if (item.kind !== "speed") {
            const family = FAMILY[item.kind];
            resolved.push({ lane: { id: `auto-${family[0]}`, kinds: family }, items: [item], automatic: true });
        }
    }

    return resolved;
}

/**
 * The lanes as edit.json keeps them once one changes (every lane on screen, automatic ones included), with every
 * item pinned to the lane it shows on, so that moving or adding a lane never
 * moves an item that only followed "the first lane that holds it".
 */
function pinned(project: EditProject): EditProject {
    const resolved = resolveLanes(project);
    let next: EditProject = { ...project, lanes: resolved.map((entry) => entry.lane) };

    for (const entry of resolved) {
        const ids = new Set(entry.items.filter((item) => item.kind !== "speed").map((item) => item.id));
        next = withLane(next, ids, entry.lane.id);
    }

    return next;
}

export function setLanes(project: EditProject, lanes: EffectLane[]): EditProject {
    const ids = lanes.map((lane) => lane.id);
    const twice = ids.find((id, index) => ids.indexOf(id) !== index);

    if (twice) {
        throw new Error(`two lanes have the id "${twice}"; each lane needs its own`);
    }

    const known = new Set(ids);
    // An item that named a lane that is gone falls back to the first lane that holds its kind.
    const unlane = <T extends { lane?: string }>(item: T): T => {
        if (!item.lane || known.has(item.lane)) {
            return item;
        }

        // An undefined key is left out when the file is written.
        return { ...item, lane: undefined };
    };
    return {
        ...project,
        lanes,
        zooms: project.zooms.map(unlane),
        ...(project.redactions ? { redactions: project.redactions.map(unlane) } : {}),
        ...(project.texts ? { texts: project.texts.map(unlane) } : {}),
        ...(project.shapes ? { shapes: project.shapes.map(unlane) } : {}),
        ...(project.camera ? { camera: { ...project.camera, hidden: project.camera.hidden.map(unlane) } } : {}),
    };
}

export function addLane(project: EditProject, lane: { id?: string; kinds?: EffectKind[]; name?: string }): EditProject {
    const base = pinned(project);
    const lanes = base.lanes ?? [];
    const id = lane.id ?? nextLaneId(lanes);
    return setLanes(base, [
        ...lanes,
        { id, ...(lane.kinds ? { kinds: lane.kinds } : {}), ...(lane.name ? { name: lane.name } : {}) },
    ]);
}

function nextLaneId(lanes: readonly EffectLane[]): string {
    let index = lanes.length + 1;

    while (lanes.some((lane) => lane.id === `lane${index}`)) {
        index += 1;
    }

    return `lane${index}`;
}

function laneIndex(lanes: readonly EffectLane[], id: string): number {
    const index = lanes.findIndex((lane) => lane.id === id);

    if (index < 0) {
        throw new Error(`no lane ${id}; lanes: ${lanes.map((lane) => lane.id).join(", ")}`);
    }

    return index;
}

/** Removes a lane; its items go to the next lane that holds their kind (or a new automatic one). */
export function removeLane(project: EditProject, id: string): EditProject {
    const base = pinned(project);
    const lanes = base.lanes ?? [];
    laneIndex(lanes, id);
    return setLanes(
        base,
        lanes.filter((lane) => lane.id !== id)
    );
}

/** Moves a lane to a place in the list (0 is the top). */
export function moveLane(project: EditProject, id: string, to: number): EditProject {
    const base = pinned(project);
    const lanes = [...(base.lanes ?? [])];
    const [lane] = lanes.splice(laneIndex(lanes, id), 1);
    lanes.splice(Math.max(0, Math.min(lanes.length, to)), 0, lane);
    return setLanes(base, lanes);
}

/** Puts an item on a lane that holds its kind. A speed item lives on its clip and has no lane of its own. */
export function moveToLane(project: EditProject, itemId: string, laneId: string): EditProject {
    const base = pinned(project);
    const lanes = base.lanes ?? [];
    const lane = lanes[laneIndex(lanes, laneId)];
    const item = laneItems(project).find((entry) => entry.id === itemId);

    if (!item) {
        throw new Error(`no zoom, hidden part, spotlight, text, shape or camera part ${itemId}`);
    }

    if (item.kind === "speed") {
        throw new Error(`${itemId} is a clip's speed; it shows on every lane that holds speed`);
    }

    if (!holds(lane, item.kind)) {
        throw new Error(`lane ${laneId} holds ${lane.kinds?.join(", ")}, not ${item.kind}`);
    }

    return withLane(base, new Set([itemId]), laneId);
}

/** Sets `lane` on the items with these ids (the ones an add op just made). */
export function withLane(project: EditProject, ids: ReadonlySet<string>, lane: string): EditProject {
    const put = <T extends { id: string; lane?: string }>(item: T): T => (ids.has(item.id) ? { ...item, lane } : item);
    return {
        ...project,
        zooms: project.zooms.map(put),
        ...(project.redactions ? { redactions: project.redactions.map(put) } : {}),
        ...(project.texts ? { texts: project.texts.map(put) } : {}),
        ...(project.shapes ? { shapes: project.shapes.map(put) } : {}),
        ...(project.camera ? { camera: { ...project.camera, hidden: project.camera.hidden.map(put) } } : {}),
    };
}

/** The ids of the zooms, hidden parts, texts, shapes and camera parts in `after` that `before` did not have. */
export function addedItemIds(before: EditProject, after: EditProject): Set<string> {
    const had = new Set(laneItems(before).map((item) => item.id));
    return new Set(
        laneItems(after)
            .map((item) => item.id)
            .filter((id) => !had.has(id))
    );
}
