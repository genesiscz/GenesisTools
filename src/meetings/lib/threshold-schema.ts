import { z } from "zod";

export const thresholdValuesSchema = z.record(z.string().min(1), z.number().finite());

const itemState = z.object({ status: z.string(), confidence: z.number().optional(), description: z.string() });
export const thresholdChangeSchema = z.object({
    key: z.string(),
    kind: z.string(),
    change: z.enum(["added", "removed", "changed"]),
    atSec: z.number().optional(),
    text: z.string(),
    before: itemState.optional(),
    after: itemState.optional(),
    reason: z.string(),
});
export type ThresholdChange = z.infer<typeof thresholdChangeSchema>;

export const thresholdsResultSchema = z.object({
    thresholds: z.array(
        z.object({
            name: z.string(),
            path: z.string(),
            title: z.string(),
            meaning: z.string(),
            min: z.number(),
            max: z.number().optional(),
            step: z.number(),
            defaultValue: z.number(),
            globalValue: z.number(),
            value: z.number(),
            source: z.string(),
        })
    ),
    changes: z.array(thresholdChangeSchema),
    counts: z.array(z.object({ kind: z.string(), added: z.number(), removed: z.number(), changed: z.number() })),
    warnings: z.array(z.string()),
});
export type ThresholdResult = z.infer<typeof thresholdsResultSchema>;
