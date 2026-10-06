import { z } from "zod";

const text = z.string().max(8000);
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export const locatorSchema = z
    .object({
        kind: z.enum(["testId", "role", "css"]),
        value: z.string().min(1).max(1000),
        name: z.string().max(1000).optional(),
        fingerprint: z
            .object({ tag: z.string().min(1).max(50), role: z.string().max(100), name: z.string().max(1000) })
            .strict()
            .optional(),
    })
    .strict()
    .refine((value) => value.kind !== "role" || value.name !== undefined, "Role targets require an exact name.")
    .refine(
        (value) => value.kind !== "css" || value.fingerprint !== undefined,
        "CSS targets require recorded identity evidence."
    );
const common = {
    id,
    title: z.string().min(1).max(300),
    evidence: z
        .object({
            eventId: text,
            url: text,
            at: z.number(),
            detail: text,
            recordedValue: text.optional(),
            recordedFilename: text.optional(),
            sha256: z
                .string()
                .regex(/^[a-f0-9]{64}$/)
                .optional(),
            recordedLocator: locatorSchema.optional(),
        })
        .strict(),
    enabled: z.boolean(),
};
export const stepSchema = z.discriminatedUnion("kind", [
    z.object({ ...common, kind: z.literal("navigate"), url: text }).strict(),
    z.object({ ...common, kind: z.literal("click"), locator: locatorSchema, pageUrl: text }).strict(),
    z.object({ ...common, kind: z.literal("fill"), locator: locatorSchema, pageUrl: text, value: text }).strict(),
    z.object({ ...common, kind: z.literal("select"), locator: locatorSchema, pageUrl: text, value: text }).strict(),
    z
        .object({
            ...common,
            kind: z.literal("press"),
            locator: locatorSchema,
            pageUrl: text,
            value: z.enum(["Enter", "Tab", "Escape", "ArrowDown", "ArrowUp", "Space"]),
        })
        .strict(),
    z
        .object({
            ...common,
            kind: z.literal("download"),
            locator: locatorSchema,
            pageUrl: text,
            filename: text,
            contains: z.array(text).max(20),
        })
        .strict(),
    z
        .object({
            ...common,
            kind: z.literal("move"),
            destination: text,
            filename: text,
            contains: z.array(text).max(20),
        })
        .strict(),
    z.object({ ...common, kind: z.literal("checkpoint"), message: text }).strict(),
    z.object({ ...common, kind: z.literal("unsupported"), reason: text }).strict(),
]);
export const recipeSchema = z
    .object({
        version: z.literal(1),
        id,
        title: z.string().min(1).max(300),
        createdAt: z.string().datetime(),
        allowedOrigins: z.array(z.string().url()).min(1).max(20),
        parameters: z
            .array(
                z
                    .object({
                        name: z.string().regex(/^[a-z][a-zA-Z0-9_]{0,63}$/),
                        label: z.string().min(1).max(100),
                        secret: z.boolean(),
                        defaultValue: text.optional(),
                    })
                    .strict()
                    .refine(
                        (value) => !value.secret || value.defaultValue === undefined,
                        "Secret inputs cannot have stored defaults."
                    )
            )
            .max(40),
        steps: z.array(stepSchema).min(1).max(200),
    })
    .strict()
    .superRefine((recipe, context) => {
        for (const [label, values] of [
            ["step", recipe.steps.map((step) => step.id)],
            ["parameter", recipe.parameters.map((parameter) => parameter.name)],
        ] as const) {
            if (new Set(values).size !== values.length) {
                context.addIssue({ code: "custom", message: `Duplicate ${label} IDs.` });
            }
        }
        const names = new Set(recipe.parameters.map((parameter) => parameter.name));
        const secrets = recipe.parameters.filter((parameter) => parameter.secret).map((parameter) => parameter.name);
        for (const step of recipe.steps) {
            for (const secret of secrets) {
                const reference = `{{${secret}}}`;
                const serialized = Object.entries(step).filter(([key]) => key !== "evidence");
                for (const [key, value] of serialized) {
                    const strings =
                        typeof value === "string"
                            ? [value]
                            : Array.isArray(value)
                              ? value.filter((entry) => typeof entry === "string")
                              : [];
                    if (
                        strings.some((entry) => entry.includes(reference)) &&
                        !(step.kind === "fill" && key === "value" && value === reference)
                    ) {
                        context.addIssue({
                            code: "custom",
                            message:
                                "Secret inputs are supported only as a whole fill value, never in URLs, paths, checks or messages.",
                        });
                    }
                }
            }
            if (
                step.kind === "fill" &&
                secrets.some((secret) => step.value === `{{${secret}}}`) &&
                step.evidence.recordedValue !== undefined
            ) {
                context.addIssue({ code: "custom", message: "A secret fill cannot retain a recorded source value." });
            }
            if (
                "locator" in step &&
                [step.locator.value, step.locator.name ?? ""].some((value) => value.includes("{{"))
            ) {
                context.addIssue({
                    code: "custom",
                    message: "Semantic target identity cannot be parameterized; repair it explicitly.",
                });
            }
            const fields = Object.entries(step).filter(
                ([key, value]) => key !== "evidence" && typeof value === "string"
            );
            for (const [, value] of fields) {
                for (const match of String(value).matchAll(/\{\{([a-z][a-zA-Z0-9_]{0,63})\}\}/g)) {
                    if (!names.has(match[1])) {
                        context.addIssue({ code: "custom", message: `Unknown parameter: ${match[1]}` });
                    }
                }
            }
            if ("contains" in step) {
                for (const value of step.contains) {
                    for (const match of value.matchAll(/\{\{([a-z][a-zA-Z0-9_]{0,63})\}\}/g)) {
                        if (!names.has(match[1])) {
                            context.addIssue({ code: "custom", message: `Unknown parameter: ${match[1]}` });
                        }
                    }
                }
            }
        }
        for (const origin of recipe.allowedOrigins) {
            try {
                if (safeUrl(origin).origin !== origin) {
                    context.addIssue({ code: "custom", message: "Allowed origins must be exact HTTP(S) origins." });
                }
            } catch {
                context.addIssue({
                    code: "custom",
                    message: "Allowed origins must be HTTP(S) origins without credentials.",
                });
            }
        }
    });
export type Recipe = z.infer<typeof recipeSchema>;
export type Step = z.infer<typeof stepSchema>;
export type Locator = z.infer<typeof locatorSchema>;
export function parseRecipe(input: unknown): Recipe {
    return recipeSchema.parse(input);
}
export function expand(value: string, inputs: Record<string, string>): string {
    const result = value.replace(/\{\{([a-z][a-zA-Z0-9_]{0,63})\}\}/g, (_match, key: string) => {
        if (!Object.hasOwn(inputs, key)) {
            throw new Error(`Missing input: ${key}`);
        }
        return inputs[key];
    });
    if (/\{\{|\}\}/.test(result)) {
        throw new Error("Malformed or unresolved parameter reference.");
    }
    return result;
}
export function safeUrl(value: string): URL {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        throw new Error("Only HTTP(S) URLs without embedded credentials are supported.");
    }
    return url;
}
export function resolvedInputs(recipe: Recipe, supplied: Record<string, string>): Record<string, string> {
    const inputs: Record<string, string> = {};
    for (const parameter of recipe.parameters) {
        const value = Object.hasOwn(supplied, parameter.name) ? supplied[parameter.name] : parameter.defaultValue;
        if (typeof value !== "string" || value.length === 0) {
            throw new Error(`Missing input: ${parameter.name}`);
        }
        inputs[parameter.name] = value;
    }
    return inputs;
}
