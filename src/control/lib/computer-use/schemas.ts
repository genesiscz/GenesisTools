import { DEFAULT_EVALUATION_PROVIDER } from "@genesiscz/utils/ai/evaluation/types";
import { z } from "zod";
import { chooserModeSchema, hostDecisionSchema } from "../decision/chooser";
import { exactExpectationSchema } from "../decision/decisions";
import { fillDataSchema } from "../decision/fill";
import { evidenceScopeSchema } from "../decision/observation";
import { recoveryOptionsSchema } from "../decision/recovery";
import { nativeSequenceSchema } from "../decision/sequence";
import { bindingSchema, workflowPlanSchema } from "../decision/workflow";

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
const preparedTarget = { ...target, prepare: z.boolean().default(false) };
const point = {
    x: z.number().finite().optional(),
    y: z.number().finite().optional(),
    coordinate_space: z.enum(["image", "screen"]).default("image"),
};
export const computerSchemas = {
    assist_task: z
        .object({
            app: appSchema,
            goal: z.string().trim().min(1).max(4000),
            host_decision: hostDecisionSchema.optional(),
            expect: z.string().trim().min(1).max(4000).optional(),
            exact: exactExpectationSchema.optional(),
            window_id: z.number().int().positive().optional(),
            expected_url: z.string().url().max(4096).optional(),
            scope: z.enum(["window", "chrome"]).default("window"),
            chooser: chooserModeSchema.default("exact"),
            jev: z.boolean().default(false),
            provider: z.enum(["vercel", "typesafe"]).default(DEFAULT_EVALUATION_PROVIDER),
            recovery: recoveryOptionsSchema.prefault({}),
            max_requests: z.number().int().min(0).max(100).default(20),
            max_steps: z.number().int().min(1).max(50).default(8),
            timeout_ms: z.number().int().min(1).max(120000).default(60000),
        })
        .strict()
        .refine((value) => value.chooser === "exact" || value.jev, "Semantic assist requires jev:true.")
        .refine(
            (value) => value.chooser !== "exact" || (value.exact !== undefined && value.recovery.mode === "off"),
            "Exact-only assist requires exact completion readback and recovery off."
        ),
    run_workflow: z
        .object({
            plan: workflowPlanSchema,
            values: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/), z.string().max(65536)).default({}),
            window_id: z.number().int().positive().optional(),
            expected_url: z.string().url().max(4096).optional(),
            rebind: z.boolean().default(false),
            jev: z.boolean().default(false),
            provider: z.enum(["vercel", "typesafe"]).default(DEFAULT_EVALUATION_PROVIDER),
            max_requests: z.number().int().min(0).max(100).default(30),
            max_steps: z.number().int().min(1).max(50).default(20),
            timeout_ms: z.number().int().min(1).max(120000).default(120000),
        })
        .strict()
        .refine((value) => !value.rebind || value.jev, "Workflow selector repair requires jev:true."),
    fill_form: z
        .object({
            app: appSchema,
            data: fillDataSchema,
            window_id: z.number().int().positive().optional(),
            expected_url: z.string().url().max(4096).optional(),
            scope: z.enum(["window", "chrome"]).default("window"),
            jev: z.literal(true),
            provider: z.enum(["vercel", "typesafe"]).default(DEFAULT_EVALUATION_PROVIDER),
            max_requests: z.number().int().min(1).max(20).default(20),
            max_fields: z.number().int().min(1).max(20).default(20),
            timeout_ms: z.number().int().min(1).max(120000).default(60000),
        })
        .strict(),
    press_sequence: nativeSequenceSchema,
    get_menu: z
        .object({
            app: appSchema,
            query: z.string().min(1).max(300).optional(),
            top_menu: z.string().min(1).max(300).optional(),
            limit: z.number().int().min(1).max(2000).default(200),
            timeout_ms: z.number().int().min(1).max(120000).optional(),
        })
        .strict(),
    perform_menu_action: z
        .object({
            app: appSchema,
            menu_ref: z.string().min(1).max(120),
            action: z
                .string()
                .regex(/^AX[A-Za-z]+$/)
                .max(100)
                .default("AXPress"),
            timeout_ms: z.number().int().min(1).max(120000).optional(),
        })
        .strict(),
    list_windows: z.object({ app: appSchema }).strict(),
    get_app_state: z
        .object({
            app: appSchema,
            disableDiff: z.boolean().default(false),
            window_id: z.number().int().positive().optional(),
            window_index: z.number().int().nonnegative().optional(),
            scope: z.enum(["window", "chrome"]).optional(),
            image: z.boolean().default(true),
            element_limit: z.number().int().min(1).max(2000).default(100),
            perception: z.enum(["ocr"]).optional(),
            timeout_ms: z.number().int().min(1).max(120000).optional(),
        })
        .strict(),
    list_apps: z
        .object({
            include_background: z.boolean().default(false),
            installed: z.boolean().default(false),
        })
        .strict(),
    launch_app: z
        .object({
            bundle_id: appSchema.optional(),
            path: z.string().min(1).max(4096).optional(),
            activate: z.boolean().default(true),
            timeout_ms: z.number().int().min(1).max(120000).optional(),
        })
        .strict()
        .refine((value) => (value.bundle_id === undefined) !== (value.path === undefined), "Choose bundle_id or path."),
    quit_app: z.object(common).strict(),
    click: z
        .object({
            ...target,
            ...point,
            mouse_button: z.enum(["left", "right", "middle", "l", "r", "m"]).default("left"),
            click_count: z.number().int().min(1).max(2).default(1),
            background: z.boolean().default(true),
            physical: z.boolean().default(false),
            prepare: z.boolean().default(false),
            region_ref: z.string().min(1).max(200).optional(),
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
    set_value: z.object({ ...preparedTarget, value: z.string().max(65536) }).strict(),
    select_text: z
        .object({
            ...preparedTarget,
            text: z.string().min(1).max(65536),
            prefix: z.string().max(1000).optional(),
            suffix: z.string().max(1000).optional(),
            selection_type: z.enum(["text", "cursor_before", "cursor_after"]).default("text"),
        })
        .strict(),
    perform_secondary_action: z.object({ ...target, action: z.string().min(1).max(100) }).strict(),
    paste: z
        .object({
            ...preparedTarget,
            text: z.string().max(65536),
            format: z.enum(["text", "md", "html"]).default("text"),
            replace: z.boolean().default(false),
        })
        .strict()
        .refine(
            (value) => !value.replace || value.prepare,
            "Replacing a field requires prepare:true for focus and readback."
        ),
    type_text: z
        .object({
            ...preparedTarget,
            text: z
                .string()
                .max(256)
                .refine((text) => !/[\r\n]/.test(text), "Use paste for multiline text; typing return can submit."),
        })
        .strict(),
    press_key: z.object({ ...preparedTarget, key: z.string().min(1).max(200) }).strict(),
    focus: z.object(target).strict(),
    get_elements: z
        .object({
            ...common,
            offset: z.number().int().nonnegative().default(0),
            limit: z.number().int().min(1).max(2000).default(100),
            text_limit: z.number().int().min(100).max(16000).default(500),
        })
        .strict(),
    find: z
        .object({
            app: appSchema,
            query: z.string().min(1).max(300),
            role: z.string().max(100).optional(),
            limit: z.number().int().min(1).max(100).default(30),
        })
        .strict(),
    resolve_visual_target: z
        .object({
            ...common,
            intent: z.string().min(1).max(4000),
            chooser: z.enum(["exact", "jev", "auto"]).default("exact"),
            provider: z.enum(["vercel", "typesafe"]).default(DEFAULT_EVALUATION_PROVIDER),
        })
        .strict(),
    resolve_target: z
        .object({
            ...common,
            intent: z.string().min(1).max(4000),
            chooser: z.enum(["exact", "jev", "auto"]).default("exact"),
            action: z.enum(["press", "set"]).default("press"),
            binding: bindingSchema.optional(),
            host_decision: hostDecisionSchema.optional(),
            within_ref: z.string().max(100).optional(),
            query: z.string().trim().min(1).max(300).optional(),
            role: z.string().min(1).max(100).optional(),
            provider: z.enum(["vercel", "typesafe"]).default(DEFAULT_EVALUATION_PROVIDER),
        })
        .strict(),
    await_condition: z
        .object({
            ...common,
            condition: z.string().trim().min(1).max(4000),
            evidence_scope: evidenceScopeSchema.optional(),
            exact: exactExpectationSchema.optional(),
            expected_url: z.string().url().max(4096).optional(),
            jev: z.boolean().default(false),
            provider: z.enum(["vercel", "typesafe"]).default(DEFAULT_EVALUATION_PROVIDER),
            max_requests: z.number().int().min(0).max(50).default(12),
        })
        .strict()
        .refine((value) => value.exact !== undefined || value.jev, "Semantic waits require jev:true."),
    verify_state: z
        .object({
            ...common,
            expect: z.string().min(1).max(4000),
            exact: exactExpectationSchema.optional(),
            jev: z.boolean().default(false),
            provider: z.enum(["vercel", "typesafe"]).default(DEFAULT_EVALUATION_PROVIDER),
        })
        .strict(),
    close_session: z.object({ app: appSchema.optional() }).strict(),
};
export type ComputerMethod = keyof typeof computerSchemas;
export type ComputerInput<M extends ComputerMethod> = z.input<(typeof computerSchemas)[M]>;
export type ComputerArgs<M extends ComputerMethod> = z.output<(typeof computerSchemas)[M]>;

export type ComputerCall<M extends ComputerMethod> = ComputerInput<M> & { signal?: AbortSignal };
