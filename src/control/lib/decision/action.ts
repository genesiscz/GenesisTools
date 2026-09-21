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
const allowed: Record<ControlAction, string[]> = {
    press: [],
    hover: ["dwell"],
    set: [],
    focus: [],
    key: ["keys"],
    type: [],
    paste: ["format"],
    select: ["selection", "prefix", "suffix"],
    perform: ["axAction"],
    click: ["button", "count", "background"],
    scroll: ["direction", "pixels", "pages", "background"],
};
export function nativeActionArguments(options: {
    action: ControlAction;
    value?: string;
    parameters?: ActionParameters;
}): string[] {
    const { action, value } = options;
    const p = actionParametersSchema.parse(options.parameters ?? {});
    for (const key of Object.keys(p)) {
        if (!allowed[action].includes(key)) {
            throw new Error(`Parameter ${key} is not valid for ${action}.`);
        }
    }
    const args = ["--action", action];
    if (["set", "type", "paste", "select"].includes(action)) {
        if (value === undefined) {
            throw new Error(`${action} requires an exact supplied value.`);
        }
        if (action === "type" && (value.length > 256 || /[\r\n]/.test(value))) {
            throw new Error("type requires at most 256 single-line UTF-16 units; use paste.");
        }
        args.push(action === "set" ? "--value" : "--text", value);
    } else if (value !== undefined) {
        throw new Error(`${action} does not accept a supplied value.`);
    }
    if (action === "key") {
        if (!p.keys) {
            throw new Error("key requires parameters.keys.");
        }
        args.push("--keys", p.keys);
    }
    if (action === "hover" && p.dwell !== undefined) {
        args.push("--dwell", String(p.dwell));
    }

    if (action === "perform") {
        if (!p.axAction) {
            throw new Error("perform requires parameters.axAction.");
        }
        args.push("--ax-action", p.axAction);
    }
    if (action === "scroll") {
        if (!p.direction || (p.pages !== undefined && p.pixels !== undefined)) {
            throw new Error("scroll requires direction and at most one of pages/pixels.");
        }
        args.push(
            "--direction",
            p.direction,
            p.pixels === undefined ? "--pages" : "--pixels",
            String(p.pixels ?? p.pages ?? 1)
        );
    }
    if (action === "click") {
        args.push("--button", p.button ?? "left");
        if (p.count === 2) {
            args.push("--double");
        }
    }
    if (action === "click" || action === "scroll") {
        if (p.background !== false) {
            args.push("--background");
        }
    }
    if (action === "paste") {
        args.push("--format", p.format ?? "text");
    }
    if (action === "select") {
        args.push("--selection", p.selection ?? "text");
        if (p.prefix !== undefined) {
            args.push("--prefix", p.prefix);
        }
        if (p.suffix !== undefined) {
            args.push("--suffix", p.suffix);
        }
    }
    return args;
}
