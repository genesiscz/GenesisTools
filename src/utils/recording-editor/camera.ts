import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { z } from "zod";

const { log } = logger.scoped("recording-editor-camera");

/** The camera's sidecar beside a recording, written by the recorder face when the recording ends. */
export const CAMERA_SIDECAR = "camera.json";

export const CAMERA_SHAPES = ["circle", "rounded", "square"] as const;
export type CameraShape = (typeof CAMERA_SHAPES)[number];

/** A corner keeps the bubble `margin` from two edges; `custom` places its centre at (x, y). */
export const CAMERA_CORNERS = ["bottomRight", "bottomLeft", "topRight", "topLeft", "custom"] as const;
export type CameraCorner = (typeof CAMERA_CORNERS)[number];

/** A stretch of SOURCE time (it moves with a cut, like a zoom) in which the bubble is not drawn. */
export const cameraHiddenSchema = z.object({
    startUs: z.number().int().nonnegative(),
    endUs: z.number().int().positive(),
});

/**
 * The camera recorded beside the screen, drawn over the picture as a bubble. Hidden ranges are a plain list until the
 * editor's lanes model takes them as lane items.
 */
export const cameraBubbleSchema = z.object({
    /** The camera's movie; a bare name is beside the source movie. */
    file: z.string().min(1),
    /** The camera's time of a source moment is `source - offsetMs`: positive when the camera started later. */
    offsetMs: z.number().int().min(-600_000).max(600_000).default(0),
    show: z.boolean().default(true),
    corner: z.enum(CAMERA_CORNERS).default("bottomRight"),
    /** The centre when `corner` is custom, as fractions of the canvas. */
    x: z.number().min(0).max(1).default(0.88),
    y: z.number().min(0).max(1).default(0.82),
    /** The bubble's side as a fraction of the canvas's short side. */
    size: z.number().min(0.08).max(0.6).default(0.24),
    shape: z.enum(CAMERA_SHAPES).default("circle"),
    /** A mirror image, as the person saw themselves while recording. */
    mirror: z.boolean().default(true),
    /** The gap to the canvas edges for a corner, as a fraction of the short side. */
    margin: z.number().min(0).max(0.2).default(0.035),
    hidden: z.array(cameraHiddenSchema).default([]),
});
export type CameraBubble = z.infer<typeof cameraBubbleSchema>;

/** What the recorder face writes into `camera.json`: the movie, when it began, and where the bubble was dragged. */
export const cameraSidecarSchema = z.object({
    version: z.literal(1),
    file: z.string().min(1),
    /** When the camera's first frame was written (ISO). */
    startedAt: z.string(),
    /** When the screen's recording began (ISO), as the face saw its live state turn to "recording". */
    screenStartedAt: z.string().optional(),
    device: z.string().optional(),
    placement: z
        .object({
            x: z.number().min(0).max(1),
            y: z.number().min(0).max(1),
            size: z.number().min(0.08).max(0.6),
            shape: z.enum(CAMERA_SHAPES),
        })
        .partial()
        .optional(),
});
export type CameraSidecar = z.infer<typeof cameraSidecarSchema>;

/** The `camera.json` beside a movie, or undefined when there is none or it does not parse (logged). */
export function readCameraSidecar(video: string): CameraSidecar | undefined {
    const path = join(dirname(video), CAMERA_SIDECAR);

    if (!existsSync(path)) {
        return undefined;
    }

    const parsed = cameraSidecarSchema.safeParse(SafeJSON.parse(readFileSync(path, "utf8"), { strict: true }));

    if (!parsed.success) {
        log.warn({ path, issues: parsed.error.issues.length }, "camera.json does not parse; no camera bubble");
        return undefined;
    }

    return parsed.data;
}

/** The bubble a new edit starts with: the sidecar's movie at the place it was dragged to while recording. */
export function bubbleFromSidecar(sidecar: CameraSidecar): CameraBubble {
    const started = Date.parse(sidecar.startedAt);
    const screen = sidecar.screenStartedAt ? Date.parse(sidecar.screenStartedAt) : Number.NaN;
    const offsetMs = Number.isFinite(started) && Number.isFinite(screen) ? Math.round(started - screen) : 0;
    const placement = sidecar.placement ?? {};
    return cameraBubbleSchema.parse({
        file: sidecar.file,
        offsetMs: Math.max(-600_000, Math.min(600_000, offsetMs)),
        ...(placement.x === undefined || placement.y === undefined
            ? {}
            : { corner: "custom", x: placement.x, y: placement.y }),
        ...(placement.size === undefined ? {} : { size: placement.size }),
        ...(placement.shape === undefined ? {} : { shape: placement.shape }),
    });
}

/** The camera movie's path for a bubble of the edit whose source movie is `video`. */
export function cameraMoviePath(bubble: Pick<CameraBubble, "file">, video: string): string {
    return isAbsolute(bubble.file) ? bubble.file : join(dirname(video), bubble.file);
}

/** The bubble's centre and side in canvas fractions of the short side, for a canvas of `width` × `height`. */
export function bubbleRect(
    bubble: CameraBubble,
    canvas: { width: number; height: number }
): { x: number; y: number; side: number } {
    const short = Math.min(canvas.width, canvas.height);
    const side = bubble.size * short;
    const margin = bubble.margin * short;
    const half = side / 2;
    const clampX = (value: number) => Math.min(canvas.width - half, Math.max(half, value));
    const clampY = (value: number) => Math.min(canvas.height - half, Math.max(half, value));
    const left = margin + half;
    const right = canvas.width - margin - half;
    const top = margin + half;
    const bottom = canvas.height - margin - half;

    switch (bubble.corner) {
        case "bottomRight":
            return { x: right, y: bottom, side };
        case "bottomLeft":
            return { x: left, y: bottom, side };
        case "topRight":
            return { x: right, y: top, side };
        case "topLeft":
            return { x: left, y: top, side };
        case "custom":
            return { x: clampX(bubble.x * canvas.width), y: clampY(bubble.y * canvas.height), side };
    }
}

/** Whether the bubble shows at a source moment: on, and outside every hidden range. */
export function bubbleShowsAt(bubble: CameraBubble, sourceUs: number): boolean {
    return bubble.show && !bubble.hidden.some((range) => sourceUs >= range.startUs && sourceUs < range.endUs);
}

/** Hides the bubble from `fromUs` to `toUs`, joined with any hidden range it touches. */
export function hideCamera(bubble: CameraBubble, fromUs: number, toUs: number): CameraBubble {
    if (toUs <= fromUs) {
        throw new Error(`a camera hide needs its end after its start (got ${fromUs / 1e6}–${toUs / 1e6} s)`);
    }

    const ranges = [...bubble.hidden, { startUs: fromUs, endUs: toUs }].sort((a, b) => a.startUs - b.startUs);
    const merged: CameraBubble["hidden"] = [];

    for (const range of ranges) {
        const last = merged.at(-1);

        if (last && range.startUs <= last.endUs) {
            last.endUs = Math.max(last.endUs, range.endUs);
        } else {
            merged.push({ ...range });
        }
    }

    return { ...bubble, hidden: merged };
}

/** Shows the bubble again from `fromUs` to `toUs`: the hidden ranges lose that part (one may split in two). */
export function showCamera(bubble: CameraBubble, fromUs: number, toUs: number): CameraBubble {
    const hidden = bubble.hidden.flatMap((range) => {
        if (range.endUs <= fromUs || range.startUs >= toUs) {
            return [range];
        }

        return [
            ...(range.startUs < fromUs ? [{ startUs: range.startUs, endUs: fromUs }] : []),
            ...(range.endUs > toUs ? [{ startUs: toUs, endUs: range.endUs }] : []),
        ];
    });
    return { ...bubble, hidden };
}
