import { z } from "zod";

/** Seconds as a number, `"75.5"`, `"01:15"` or `"1:02:03.5"`. */
export const timeSchema = z.union([
    z.number().finite().nonnegative(),
    z.string().regex(/^(?:(?:\d+:)?\d{1,2}:\d{1,2}(?:\.\d+)?|\d+(?:\.\d+)?s?)$/, "a time is seconds, mm:ss or h:mm:ss"),
]);
export type TimeValue = z.infer<typeof timeSchema>;

/** Microseconds of a time value, rounded to a whole microsecond. */
export function timeToUs(value: TimeValue): number {
    if (typeof value === "number") {
        return Math.round(value * 1_000_000);
    }

    const parts = value.replace(/s$/, "").split(":").map(Number);
    const seconds = parts.reduce((total, part) => total * 60 + part, 0);
    return Math.round(seconds * 1_000_000);
}

const window = {
    from: timeSchema.optional(),
    to: timeSchema.optional(),
    /** Exact microseconds; wins over `from` and `to`. */
    fromUs: z.number().int().nonnegative().optional(),
    toUs: z.number().int().positive().optional(),
};

export const rangeStepSchema = z.object({ kind: z.literal("range"), ...window }).strict();
export const trimStepSchema = z.object({ kind: z.literal("trim"), ...window }).strict();
export const speedStepSchema = z.object({ kind: z.literal("speed"), factor: z.number().min(0.25).max(16) }).strict();
export const framesStepSchema = z
    .object({
        kind: z.literal("frames"),
        /** Samples a second; a frames source keeps every frame when omitted, a video samples 2 a second. */
        fps: z.number().min(0.05).max(30).optional(),
        /** Keeps a frame only when it differs from the last kept one by `threshold` percent of its pixels. */
        changeOnly: z.boolean().optional(),
        threshold: z.number().min(0).max(100).optional(),
        /** Only these displays of a multi-display recording. */
        displays: z.array(z.number().int()).min(1).optional(),
    })
    .strict()
    .refine((step) => step.threshold === undefined || step.changeOnly, {
        message: "threshold needs changeOnly: true",
        path: ["threshold"],
    });
export const GRID_LABELS = ["time", "sample", "index", "none"] as const;
export const gridStepSchema = z
    .object({
        kind: z.literal("grid"),
        cols: z.number().int().min(1).max(8).optional(),
        rows: z.number().int().min(1).max(8).optional(),
        /** Frames per image when cols and rows are not both given; the columns then follow the square root. */
        perImage: z.number().int().min(1).max(32).optional(),
        labels: z.enum(GRID_LABELS).default("time"),
        maxWidth: z.number().int().min(256).max(8192).optional(),
    })
    .strict()
    .refine((step) => (step.cols ?? 1) * (step.rows ?? 1) <= 32, {
        message: "a grid holds at most 32 frames (cols × rows)",
        path: ["rows"],
    });
export const EXPORT_FORMATS = ["mp4", "gif", "webm"] as const;
export const exportStepSchema = z
    .object({
        kind: z.literal("export"),
        format: z.enum(EXPORT_FORMATS),
        /** The file to write; it must not be an input. Default: `export.<format>` in the job's folder. */
        output: z.string().min(1).optional(),
    })
    .strict();

export const editStepSchema = z.union([
    rangeStepSchema,
    trimStepSchema,
    speedStepSchema,
    framesStepSchema,
    gridStepSchema,
    exportStepSchema,
]);
export type EditStep = z.infer<typeof editStepSchema>;

export const STORES = ["recordings", "meetings"] as const;
export const editSourceSchema = z.union([
    z.object({ recording: z.string().min(1), store: z.enum(STORES).optional() }).strict(),
    z.object({ file: z.string().min(1) }).strict(),
]);
export type EditSource = z.infer<typeof editSourceSchema>;

export const editPlanSchema = z
    .object({
        source: editSourceSchema,
        steps: z.array(editStepSchema).min(1).max(40),
        /** The job's folder. Default: one folder per source under the recordings store's `edits/`. */
        output: z.string().min(1).optional(),
    })
    .strict()
    .superRefine((plan, ctx) => {
        for (const [index, step] of plan.steps.entries()) {
            if (step.kind === "grid" && !plan.steps.slice(0, index).some((one) => one.kind === "frames")) {
                ctx.addIssue({
                    code: "custom",
                    message: "a grid needs a frames step before it",
                    path: ["steps", index],
                });
            }
        }
    });
export type EditPlan = z.infer<typeof editPlanSchema>;
export type EditPlanInput = z.input<typeof editPlanSchema>;

/** The plan, validated; a ZodError names the step and the field that is wrong. */
export function parseEditPlan(plan: unknown): EditPlan {
    return editPlanSchema.parse(plan);
}

/** The window of a range or trim step in microseconds; `undefined` ends mean the source's ends. */
export function stepWindow(step: { from?: TimeValue; to?: TimeValue; fromUs?: number; toUs?: number }): {
    fromUs?: number;
    toUs?: number;
} {
    const fromUs = step.fromUs ?? (step.from !== undefined ? timeToUs(step.from) : undefined);
    const toUs = step.toUs ?? (step.to !== undefined ? timeToUs(step.to) : undefined);

    if (fromUs !== undefined && toUs !== undefined && toUs <= fromUs) {
        throw new Error("The range must end after it starts");
    }

    return { fromUs, toUs };
}
