import { z } from "zod";
import { recordingItemId } from "./item-ids";
import { sourceTimeSchema, timeToUs } from "./plan";

/**
 * The render effects of round 4 (agent fx-render): transitions at the joins of two clips, the magnifier lens, and
 * the 3D tilt of the framed picture. Each is one object of the edit (`transitions`, `lens`, `tilt`); absent is off,
 * so an older edit loads unchanged. The editor window draws them (Render/RenderFx.swift), and so does every export.
 */

/** #RRGGBB, as project.ts's hexColor (not imported: project.ts imports this file). */
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "a color is #RRGGBB");

export const TRANSITION_KINDS = ["none", "crossfade", "zoom", "blur"] as const;
export type TransitionKind = (typeof TRANSITION_KINDS)[number];

const transitionSchema = z.object({
    kind: z.enum(TRANSITION_KINDS).default("none"),
    /** The whole length, centred on the join: half before it, half after. */
    ms: z.number().int().min(50).max(2000).default(300),
});

/** `default` is every join's; `joins` overrides one join, keyed by the id of the clip that starts there. */
export const transitionsSchema = z.object({
    default: transitionSchema.default({ kind: "none", ms: 300 }),
    joins: z.record(z.string(), transitionSchema).optional(),
});
export type EditTransitions = z.infer<typeof transitionsSchema>;

/** One loupe over a SOURCE range: it follows the cursor, or stays at `x`/`y` (0...1 of the source picture). */
export const lensItemSchema = z.object({
    id: z.string(),
    startUs: z.number().int().nonnegative(),
    endUs: z.number().int().positive(),
    /** As a fraction of the picture's short side. */
    radius: z.number().min(0.04).max(0.4).default(0.12),
    magnification: z.number().min(1.5).max(4).default(2),
    /** Follows the recorded cursor; a movie without a cursor track holds x and y. */
    follow: z.boolean().default(true),
    x: z.number().min(0).max(1).default(0.5),
    y: z.number().min(0).max(1).default(0.5),
    ring: hexColor.default("#FFFFFF"),
});
export type EditLens = z.infer<typeof lensItemSchema>;

export const lensSchema = z.object({ items: z.array(lensItemSchema).default([]) });

/** A slight perspective tilt of the framed picture (and its shadow), drifting slowly, tilting in and out. */
export const tiltSchema = z.object({
    strength: z.number().min(0).max(1).default(0.5),
    drift: z.boolean().default(true),
    tiltIn: z.boolean().default(true),
    tiltOut: z.boolean().default(true),
    inMs: z.number().int().min(100).max(5000).default(1200),
    outMs: z.number().int().min(100).max(5000).default(1200),
});
export type EditTilt = z.infer<typeof tiltSchema>;

const point = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict();

/** The ops, appended to `editOpSchema` in project.ts. */
export const fxOpSchemas = [
    /**
     * The transition at the joins: without `clip` the edit-wide default, with `clip` the one join where that clip
     * starts (`kind: "default"` drops the override). info().transitions.joins lists every join.
     */
    z
        .object({
            op: z.literal("transition"),
            kind: z.enum([...TRANSITION_KINDS, "default"]).optional(),
            ms: z.number().int().min(50).max(2000).optional(),
            clip: z.string().optional(),
        })
        .strict(),
    /** A magnifier lens from `from` to `to` (SOURCE seconds); it follows the cursor unless `at` or follow: false. */
    z
        .object({
            op: z.literal("lens"),
            from: sourceTimeSchema,
            to: sourceTimeSchema,
            radius: z.number().min(0.04).max(0.4).optional(),
            magnification: z.number().min(1.5).max(4).optional(),
            follow: z.boolean().optional(),
            at: point.optional(),
            ring: hexColor.optional(),
        })
        .strict(),
    /** Changes a lens that exists; `at` also stops it following the cursor unless `follow` says. */
    z
        .object({
            op: z.literal("setLens"),
            id: z.string(),
            from: sourceTimeSchema.optional(),
            to: sourceTimeSchema.optional(),
            radius: z.number().min(0.04).max(0.4).optional(),
            magnification: z.number().min(1.5).max(4).optional(),
            follow: z.boolean().optional(),
            at: point.optional(),
            ring: hexColor.optional(),
        })
        .strict(),
    z.object({ op: z.literal("unlens"), id: z.string() }).strict(),
    /** The 3D tilt camera; enabled: false removes it. */
    z
        .object({
            op: z.literal("tilt"),
            enabled: z.boolean().optional(),
            strength: z.number().min(0).max(1).optional(),
            drift: z.boolean().optional(),
            tiltIn: z.boolean().optional(),
            tiltOut: z.boolean().optional(),
            inMs: z.number().int().min(100).max(5000).optional(),
            outMs: z.number().int().min(100).max(5000).optional(),
        })
        .strict(),
] as const;

type FxOpSchema = (typeof fxOpSchemas)[number];
export type FxOp = z.infer<FxOpSchema>;
export const FX_OP_NAMES: ReadonlyArray<FxOp["op"]> = ["transition", "lens", "setLens", "unlens", "tilt"];

/** What fx needs of an edit; project.ts's EditProject has these fields. */
export interface FxProject {
    source: { durationUs: number };
    clips: ReadonlyArray<{ id: string; fromUs: number; toUs: number; speed: number }>;
    transitions?: EditTransitions;
    lens?: { items: EditLens[] };
    tilt?: EditTilt;
}

export function isFxOp(op: { op: string }): op is FxOp {
    return (FX_OP_NAMES as readonly string[]).includes(op.op);
}

export interface TransitionJoin {
    /** The clip that starts at the join. */
    clip: string;
    /** Output microseconds of the join. */
    atUs: number;
    kind: TransitionKind;
    ms: number;
    /** True when the join has its own transition, not the default. */
    own: boolean;
}

/**
 * Every join of the edit: the start of a clip whose source does not continue the clip before it (a split alone joins
 * nothing). The Swift side has the same rule (RenderFx.swift, `Transitions.joins`).
 */
export function transitionJoins(project: FxProject): TransitionJoin[] {
    const joins: TransitionJoin[] = [];
    const base = transitionsSchema.parse(project.transitions ?? {});
    let at = 0;
    let previous: FxProject["clips"][number] | undefined;

    for (const clip of project.clips) {
        const length = Math.max(0, clip.toUs - clip.fromUs);

        if (length === 0) {
            continue;
        }

        if (previous && previous.toUs !== clip.fromUs) {
            const own = base.joins?.[clip.id];
            const chosen = own ?? base.default;
            joins.push({ clip: clip.id, atUs: at, kind: chosen.kind, ms: chosen.ms, own: own !== undefined });
        }

        at += Math.round(length / clip.speed);
        previous = clip;
    }

    return joins;
}

function seconds(us: number): number {
    return Math.round(us / 1000) / 1000;
}

/** info()'s view of the three effects: seconds, every join with its transition, null where an effect is off. */
export function describeFx(project: FxProject) {
    const transitions = transitionsSchema.parse(project.transitions ?? {});
    return {
        transitions: {
            default: transitions.default,
            joins: transitionJoins(project).map((join) => ({
                clip: join.clip,
                at: seconds(join.atUs),
                kind: join.kind,
                ms: join.ms,
                ...(join.own ? { own: true } : {}),
            })),
        },
        lenses: (project.lens?.items ?? []).map((lens) => ({
            id: lens.id,
            from: seconds(lens.startUs),
            to: seconds(lens.endUs),
            radius: lens.radius,
            magnification: lens.magnification,
            follow: lens.follow,
            at: { x: lens.x, y: lens.y },
            ring: lens.ring,
        })),
        tilt: project.tilt ?? null,
    };
}

function lensRange(project: FxProject, from: number, to: number): { startUs: number; endUs: number } {
    const startUs = from;
    const endUs = Math.min(project.source.durationUs, to);

    if (startUs >= project.source.durationUs) {
        throw new RangeError(
            `from (${seconds(startUs)} s) is past the end of the ${seconds(project.source.durationUs)} s movie`
        );
    }

    if (endUs - startUs < 100_000) {
        throw new RangeError(
            `a lens needs at least 0.1 s; from ${seconds(startUs)} s to ${seconds(endUs)} s is shorter`
        );
    }

    return { startUs, endUs };
}

/** One fx op on an edit; project.ts's applyOp sends these here. */
export function applyFxOp<P extends FxProject>(project: P, op: FxOp): P {
    switch (op.op) {
        case "transition": {
            const current = transitionsSchema.parse(project.transitions ?? {});

            if (op.clip === undefined) {
                if (op.kind === "default") {
                    throw new RangeError('kind "default" names a join\'s own transition; give clip too');
                }

                const next = {
                    ...current.default,
                    ...(op.kind ? { kind: op.kind } : {}),
                    ...(op.ms ? { ms: op.ms } : {}),
                };
                return { ...project, transitions: { ...current, default: next } };
            }

            const joins = transitionJoins(project);

            if (!joins.some((join) => join.clip === op.clip)) {
                const known = joins.map((join) => join.clip).join(", ") || "none (the edit has no cut)";
                throw new Error(`clip ${op.clip} starts no join; the joins start at clips: ${known}`);
            }

            const { [op.clip]: own, ...others } = current.joins ?? {};

            if (op.kind === "default") {
                return {
                    ...project,
                    transitions: { default: current.default, ...(Object.keys(others).length ? { joins: others } : {}) },
                };
            }

            const next = transitionSchema.parse({
                ...(own ?? current.default),
                ...(op.kind ? { kind: op.kind } : {}),
                ...(op.ms ? { ms: op.ms } : {}),
            });
            return { ...project, transitions: { default: current.default, joins: { ...others, [op.clip]: next } } };
        }
        case "lens": {
            const range = lensRange(project, timeToUs(op.from), timeToUs(op.to));
            const lens = lensItemSchema.parse({
                id: recordingItemId("l"),
                ...range,
                ...(op.radius === undefined ? {} : { radius: op.radius }),
                ...(op.magnification === undefined ? {} : { magnification: op.magnification }),
                follow: op.follow ?? op.at === undefined,
                ...(op.at ? { x: op.at.x, y: op.at.y } : {}),
                ...(op.ring ? { ring: op.ring.toUpperCase() } : {}),
            });
            return { ...project, lens: { items: [...(project.lens?.items ?? []), lens] } };
        }
        case "setLens": {
            const items = project.lens?.items ?? [];
            const found = items.find((lens) => lens.id === op.id);

            if (!found) {
                throw new Error(`no lens ${op.id}; lenses: ${items.map((lens) => lens.id).join(", ") || "none"}`);
            }

            const range = lensRange(
                project,
                op.from === undefined ? found.startUs : timeToUs(op.from),
                op.to === undefined ? found.endUs : timeToUs(op.to)
            );
            const changed = lensItemSchema.parse({
                ...found,
                ...range,
                ...(op.radius === undefined ? {} : { radius: op.radius }),
                ...(op.magnification === undefined ? {} : { magnification: op.magnification }),
                ...(op.at ? { x: op.at.x, y: op.at.y, follow: false } : {}),
                ...(op.follow === undefined ? {} : { follow: op.follow }),
                ...(op.ring ? { ring: op.ring.toUpperCase() } : {}),
            });
            return { ...project, lens: { items: items.map((lens) => (lens.id === op.id ? changed : lens)) } };
        }
        case "unlens": {
            const items = project.lens?.items ?? [];

            if (!items.some((lens) => lens.id === op.id)) {
                throw new Error(`no lens ${op.id}; lenses: ${items.map((lens) => lens.id).join(", ") || "none"}`);
            }

            const rest = items.filter((lens) => lens.id !== op.id);

            if (rest.length > 0) {
                return { ...project, lens: { items: rest } };
            }

            return { ...project, lens: undefined };
        }
        case "tilt": {
            const { op: _op, enabled, ...change } = op;

            if (enabled === false) {
                return { ...project, tilt: undefined };
            }

            return { ...project, tilt: tiltSchema.parse({ ...project.tilt, ...change }) };
        }
    }
}
