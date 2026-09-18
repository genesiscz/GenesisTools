import { z } from "zod";
import { exactExpectationSchema } from "../decision/decisions";
import { bindingSchema } from "../decision/workflow";

export const appSchema = z.string().trim().min(1).max(300);
const common = {
    app: appSchema,
    revision: z.string().min(1).max(80).optional(),
    timeout_ms: z.number().int().min(1).max(120000).optional(),
};
const target = {
    ...common,
    element_index: z.number().int().nonnegative().optional(),
    element_ref: z.string().min(1).max(100).optional(),
};
const point = {
    x: z.number().finite().optional(),
    y: z.number().finite().optional(),
    coordinate_space: z.enum(["image", "screen"]).default("image"),
};
export const computerSchemas = {
    get_app_state: z
        .object({
            app: appSchema,
            disableDiff: z.boolean().default(false),
            window_id: z.number().int().positive().optional(),
            window_index: z.number().int().nonnegative().optional(),
            scope: z.enum(["window", "chrome"]).optional(),
            image: z.boolean().default(true),
            perception: z.enum(["ocr"]).optional(),
            timeout_ms: z.number().int().min(1).max(120000).optional(),
        })
        .strict(),
    list_apps: z.object({ include_background: z.boolean().default(false) }).strict(),
    click: z
        .object({
            ...target,
            ...point,
            mouse_button: z.enum(["left", "right", "middle", "l", "r", "m"]).default("left"),
            click_count: z.number().int().min(1).max(2).default(1),
            background: z.boolean().default(true),
            physical: z.boolean().default(false),
        })
        .strict(),
    drag: z
        .object({
            ...common,
            from_x: z.number().finite(),
            from_y: z.number().finite(),
            to_x: z.number().finite(),
            to_y: z.number().finite(),
            coordinate_space: z.enum(["image", "screen"]).default("image"),
            duration: z.number().min(0.1).max(5).default(0.3),
            background: z.boolean().default(true),
        })
        .strict(),
    scroll: z
        .object({
            ...target,
            ...point,
            direction: z.enum(["up", "down", "left", "right", "u", "d", "l", "r"]),
            pages: z.number().int().min(1).max(20).optional(),
            pixels: z.number().int().min(1).max(10000).optional(),
            background: z.boolean().default(true),
        })
        .strict(),
    set_value: z.object({ ...target, value: z.string().max(65536) }).strict(),
    select_text: z
        .object({
            ...target,
            text: z.string().min(1).max(65536),
            prefix: z.string().max(1000).optional(),
            suffix: z.string().max(1000).optional(),
            selection_type: z.enum(["text", "cursor_before", "cursor_after"]).default("text"),
        })
        .strict(),
    perform_secondary_action: z.object({ ...target, action: z.string().min(1).max(100) }).strict(),
    paste: z
        .object({ ...target, text: z.string().max(65536), format: z.enum(["text", "md", "html"]).default("text") })
        .strict(),
    type_text: z
        .object({
            ...target,
            text: z
                .string()
                .max(256)
                .refine((text) => !/[\r\n]/.test(text), "Use paste for multiline text; typing return can submit."),
        })
        .strict(),
    press_key: z.object({ ...target, key: z.string().min(1).max(200) }).strict(),
    focus: z.object(target).strict(),
    find: z
        .object({
            app: appSchema,
            query: z.string().min(1).max(300),
            role: z.string().max(100).optional(),
            limit: z.number().int().min(1).max(100).default(30),
        })
        .strict(),
    resolve_target: z
        .object({
            ...common,
            intent: z.string().min(1).max(4000),
            chooser: z.enum(["exact", "jev", "auto"]).default("exact"),
            action: z.enum(["press", "set"]).default("press"),
            binding: bindingSchema.optional(),
            within_ref: z.string().max(100).optional(),
            provider: z.enum(["vercel", "typesafe"]).default("vercel"),
        })
        .strict(),
    verify_state: z
        .object({
            ...common,
            expect: z.string().min(1).max(4000),
            exact: exactExpectationSchema.optional(),
            jev: z.boolean().default(false),
            provider: z.enum(["vercel", "typesafe"]).default("vercel"),
        })
        .strict(),
    close_session: z.object({ app: appSchema.optional() }).strict(),
};
export type ComputerMethod = keyof typeof computerSchemas;
export type ComputerInput<M extends ComputerMethod> = z.input<(typeof computerSchemas)[M]>;
export type ComputerArgs<M extends ComputerMethod> = z.output<(typeof computerSchemas)[M]>;

export type ComputerCall<M extends ComputerMethod> = ComputerInput<M> & { signal?: AbortSignal };
