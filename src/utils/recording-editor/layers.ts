import { z } from "zod";
import { CAMERA_SHAPES } from "./camera";
import { recordingItemId } from "./item-ids";
import type { EditOp, EditProject, OpFacts } from "./project";

export const MEDIA_LAYER_KINDS = ["image", "video"] as const;
export const CAMERA_LAYER_ID = "camera";

/** Times follow the source through cuts. The centre and width are fractions of the canvas. */
export const mediaLayerSchema = z.object({
    id: z.string().min(1),
    kind: z.enum(MEDIA_LAYER_KINDS),
    file: z.string().min(1),
    startUs: z.number().int().nonnegative(),
    endUs: z.number().int().positive(),
    x: z.number().min(0).max(1).default(0.5),
    y: z.number().min(0).max(1).default(0.5),
    width: z.number().min(0.05).max(1).default(0.35),
    opacity: z.number().min(0).max(1).default(1),
    shape: z.enum(CAMERA_SHAPES).optional(),
    hidden: z.boolean().default(false),
    name: z.string().max(40).optional(),
    videoStartMs: z.number().int().nonnegative().default(0),
    videoSound: z.boolean().default(false),
    loop: z.boolean().default(false),
});
export type MediaLayer = z.infer<typeof mediaLayerSchema>;

export const layerStackSchema = z.object({
    order: z.array(z.string()).default([]),
    media: z.array(mediaLayerSchema).default([]),
});

type LayerRef = { id: string; kind: "camera" | MediaLayer["kind"] };

export function layerOrderOf(project: EditProject): LayerRef[] {
    const remaining = new Map<string, LayerRef>();
    const order = project.layers?.order ?? [];
    const result: LayerRef[] = [];
    if (project.camera) {
        const camera: LayerRef = { id: CAMERA_LAYER_ID, kind: "camera" };
        if (order.includes(CAMERA_LAYER_ID)) {
            remaining.set(camera.id, camera);
        } else {
            result.push(camera);
        }
    }

    for (const { id, kind } of project.layers?.media ?? []) {
        if (id !== CAMERA_LAYER_ID) {
            remaining.set(id, { id, kind });
        }
    }

    for (const id of order) {
        const layer = remaining.get(id);
        if (layer) {
            result.push(layer);
            remaining.delete(id);
        }
    }

    return [...result, ...remaining.values()];
}

/** Index zero is the bottom. A step past either edge leaves the edit unchanged. */
export function moveLayer(
    project: EditProject,
    id: string,
    to: "top" | "bottom" | "up" | "down" | number
): EditProject {
    const order = layerOrderOf(project).map((layer) => layer.id);
    const index = order.indexOf(id);
    if (index < 0) {
        throw new Error(`no layer ${id}`);
    }

    const last = order.length - 1;
    const targets = { top: last, bottom: 0, up: index + 1, down: index - 1 };
    const target = Math.min(last, Math.max(0, typeof to === "number" ? to : targets[to]));
    if (index === target) {
        return project;
    }

    order.splice(index, 1);
    order.splice(target, 0, id);
    return { ...project, layers: { media: project.layers?.media ?? [], order } };
}

function layerEndUs(startUs: number, endUs: number, durationUs: number): number {
    const end = Math.min(endUs, durationUs);
    if (startUs >= end) {
        throw new RangeError("a layer must start before it ends and inside the source movie");
    }

    return end;
}

export function addMediaLayer(
    project: EditProject,
    op: Extract<EditOp, { op: "layerAdd" }>,
    facts: OpFacts
): EditProject {
    const startUs = op.startUs ?? facts.playheadUs ?? project.clips[0].fromUs;
    let endUs = op.endUs;
    if (endUs === undefined) {
        const duration = op.kind === "image" ? 5_000_000 : facts.videoDurationUs;
        if (duration === undefined) {
            throw new Error("layerAdd needs the video's duration or an explicit endUs");
        }

        endUs = startUs + duration;
    }

    const layer = mediaLayerSchema.parse({
        ...op,
        id: recordingItemId("l"),
        startUs,
        endUs: layerEndUs(startUs, endUs, project.source.durationUs),
    });
    return {
        ...project,
        layers: {
            order: [...layerOrderOf(project).map((item) => item.id), layer.id],
            media: [...(project.layers?.media ?? []), layer],
        },
    };
}

export function editMediaLayer(
    project: EditProject,
    op: Extract<EditOp, { op: "layer" | "layerRemove" }>
): EditProject {
    const stack = project.layers;
    const layer = stack?.media.find((item) => item.id === op.id);
    if (!stack || !layer) {
        throw new Error(`no layer ${op.id}`);
    }

    if (op.op === "layerRemove") {
        const media = stack.media.filter((item) => item.id !== layer.id);
        return { ...project, layers: { media, order: stack.order.filter((id) => id !== layer.id) } };
    }

    if (
        layer.kind !== "video" &&
        (op.videoStartMs !== undefined || op.videoSound !== undefined || op.loop !== undefined)
    ) {
        throw new Error("videoStartMs, videoSound and loop require a video layer");
    }

    const { op: _op, shape, ...change } = op;
    const { shape: oldShape, ...old } = layer;
    const nextShape = shape === undefined ? oldShape : shape;
    const endUs = layerEndUs(change.startUs ?? layer.startUs, change.endUs ?? layer.endUs, project.source.durationUs);
    const updated = mediaLayerSchema.parse({ ...old, ...change, endUs, ...(nextShape ? { shape: nextShape } : {}) });
    return { ...project, layers: { ...stack, media: stack.media.map((item) => (item.id === op.id ? updated : item)) } };
}

/** Keep a stale order readable for check() until a writer next saves. Implicit order stays implicit. */
export function layersForSave(project: EditProject): EditProject {
    const stack = project.layers;
    if (!stack) {
        return project;
    }

    const present = new Set(layerOrderOf(project).map((layer) => layer.id));
    const order = stack.order.filter((id) => present.delete(id));
    const duration = project.source.durationUs;
    const media = stack.media.map((layer) => {
        if (layer.endUs <= duration && layer.startUs < duration) {
            return layer;
        }

        return { ...layer, startUs: Math.min(layer.startUs, duration - 1), endUs: Math.min(layer.endUs, duration) };
    });
    return { ...project, layers: { ...stack, order, media } };
}
