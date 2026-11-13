import { z } from "zod";

export const controlActions = [
    "press",
    "hover",
    "set",
    "click",
    "focus",
    "key",
    "type",
    "paste",
    "select",
    "scroll",
    "perform",
] as const;
export type ControlAction = (typeof controlActions)[number];
export const actionParametersSchema = z
    .object({
        keys: z.string().min(1).max(200).optional(),
        direction: z.enum(["up", "down", "left", "right"]).optional(),
        pixels: z.number().int().min(1).max(10000).optional(),
        pages: z.number().int().min(1).max(20).optional(),
        axAction: z
            .string()
            .regex(/^AX[A-Za-z]+$/)
            .max(100)
            .optional(),
        format: z.enum(["text", "md", "html"]).optional(),
        selection: z.enum(["text", "cursor_before", "cursor_after"]).optional(),
        prefix: z.string().max(1000).optional(),
        suffix: z.string().max(1000).optional(),
        button: z.enum(["left", "right", "middle"]).optional(),
        count: z.number().int().min(1).max(2).optional(),
        background: z.boolean().optional(),
        dwell: z.number().int().min(1).max(10000).optional(),
    })
    .strict();
export type ActionParameters = z.infer<typeof actionParametersSchema>;
