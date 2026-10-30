import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

/**
 * The capture geometry GenesisTools.app writes beside every `--snapshot` PNG (`shot.png` -> `shot.geometry.json`,
 * Sources/Host/App/SnapshotGeometry.swift). A pair drawn at different point sizes is not comparable: on 2026-10-11 the
 * hub befores were 2056 x 1290 pt and the afters 1440 x 900 pt, some at 1x and some at 2x, and nothing warned.
 */
export interface SnapshotGeometry {
    version: number;
    /** The app face that drew it: `hub`, `features` (Settings and Clicky pages). */
    face: string;
    /** What the image shows, in points. */
    window: { width: number; height: number };
    /** Image pixels per point. */
    scale: number;
    backingScale: number;
    image: { width: number; height: number };
    build: { binary: string | null; commit: string | null; commitSource: string; dirty?: boolean; executable?: string };
    capturedAt: string;
}

export function geometrySidecarPath(png: string): string {
    return `${png.replace(/\.png$/i, "")}.geometry.json`;
}

function record(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value))
        : undefined;
}

function size(value: unknown): { width: number; height: number } | undefined {
    const fields = record(value);
    if (!fields || typeof fields.width !== "number" || typeof fields.height !== "number") {
        return undefined;
    }

    return { width: fields.width, height: fields.height };
}

function text(value: unknown): string | null {
    return typeof value === "string" ? value : null;
}

/** Narrows a parsed sidecar; undefined when a required field is missing or of another type. */
export function parseSnapshotGeometry(value: unknown): SnapshotGeometry | undefined {
    const fields = record(value);
    const window = size(fields?.window);
    const image = size(fields?.image);
    const build = record(fields?.build);
    if (!fields || !window || !image || typeof fields.scale !== "number" || typeof fields.version !== "number") {
        return undefined;
    }

    return {
        version: fields.version,
        face: text(fields.face) ?? "unknown",
        window,
        scale: fields.scale,
        backingScale: typeof fields.backingScale === "number" ? fields.backingScale : fields.scale,
        image,
        build: {
            binary: text(build?.binary),
            commit: text(build?.commit),
            commitSource: text(build?.commitSource) ?? "unknown",
            ...(typeof build?.dirty === "boolean" ? { dirty: build.dirty } : {}),
            ...(typeof build?.executable === "string" ? { executable: build.executable } : {}),
        },
        capturedAt: text(fields.capturedAt) ?? "",
    };
}

/** The sidecar of `png`, or undefined when there is none (a screenshot from another tool) or it does not parse. */
export async function readSnapshotGeometry(png: string): Promise<SnapshotGeometry | undefined> {
    const path = geometrySidecarPath(png);
    const file = Bun.file(path);
    if (!(await file.exists())) {
        return undefined;
    }

    const parsed = parseSnapshotGeometry(SafeJSON.parse(await file.text(), { strict: true }));
    if (!parsed) {
        logger.warn({ path }, "snapshot geometry sidecar has an unknown shape; comparing by pixels only");
    }

    return parsed;
}

/** `1440x900 pt @2x`. */
export function describeGeometry(geometry: SnapshotGeometry): string {
    return `${geometry.window.width}x${geometry.window.height} pt @${geometry.scale}x`;
}

export type PairGeometry =
    | { kind: "unknown"; missing: Array<"a" | "b"> }
    | { kind: "same"; a: SnapshotGeometry; b: SnapshotGeometry }
    /** Same point size at another scale: B is resampled onto A's pixels, and the result says so. */
    | { kind: "rescale"; a: SnapshotGeometry; b: SnapshotGeometry; message: string }
    /** Another point size: refused unless the caller asks to resize. */
    | { kind: "size-mismatch"; a: SnapshotGeometry; b: SnapshotGeometry; message: string };

export function comparePairGeometry(a: SnapshotGeometry | undefined, b: SnapshotGeometry | undefined): PairGeometry {
    if (!a || !b) {
        return { kind: "unknown", missing: [...(a ? [] : ["a" as const]), ...(b ? [] : ["b" as const])] };
    }

    if (a.window.width !== b.window.width || a.window.height !== b.window.height) {
        return {
            kind: "size-mismatch",
            a,
            b,
            message: `capture size differs: A is ${describeGeometry(a)}, B is ${describeGeometry(b)}`,
        };
    }

    if (a.scale !== b.scale) {
        return {
            kind: "rescale",
            a,
            b,
            message: `B resampled from @${b.scale}x to A's @${a.scale}x (both ${a.window.width}x${a.window.height} pt)`,
        };
    }

    return { kind: "same", a, b };
}
