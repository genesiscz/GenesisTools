import { z } from "zod";

const finite = z.number().finite();
const reserved = new Set([
    "time",
    "step",
    "min",
    "max",
    "abs",
    "clamp",
    "lag",
    "__proto__",
    "constructor",
    "prototype",
]);
const identifier = z
    .string()
    .regex(/^[A-Za-z_][A-Za-z_0-9]{0,63}$/)
    .refine((value) => !reserved.has(value), "This identifier is reserved by the formula language.");
const label = z.string().trim().min(1).max(160);
const expression = z.string().trim().min(1).max(4096);
const rangeSchema = z
    .object({ min: finite, max: finite, step: finite.positive() })
    .strict()
    .refine(
        (range) =>
            range.min < range.max &&
            Number.isFinite(range.max - range.min) &&
            Number.isFinite((range.max - range.min) / range.step),
        "An input range needs finite increasing endpoints and a positive representable step."
    );
const commonQuantity = {
    id: identifier,
    label,
    unit: z.string().max(256),
    description: z.string().max(8000).default(""),
    provenance: z.enum(["assumption", "identity", "measured", "estimate"]).default("assumption"),
    seed: finite.optional(),
    range: rangeSchema.optional(),
    position: z
        .object({ x: finite.min(0).max(8192), y: finite.min(0).max(8192) })
        .strict()
        .default({ x: 0, y: 0 }),
};

export const quantitySchema = z.discriminatedUnion("kind", [
    z.object({ ...commonQuantity, kind: z.literal("input"), value: finite }).strict(),
    z.object({ ...commonQuantity, kind: z.literal("formula"), expression }).strict(),
    z
        .object({
            ...commonQuantity,
            kind: z.literal("stock"),
            initial: finite,
            derivative: expression,
            min: finite.optional(),
            max: finite.optional(),
        })
        .strict(),
    z
        .object({
            ...commonQuantity,
            kind: z.literal("data"),
            points: z
                .array(z.object({ time: finite.nonnegative(), value: finite }).strict())
                .min(1)
                .max(10000),
            interpolation: z.enum(["hold", "linear"]),
            source: z.string().max(8000),
        })
        .strict(),
]);

export const scenarioSchema = z
    .object({
        id: identifier,
        label,
        description: z.string().max(8000).default(""),
        color: z
            .string()
            .regex(/^#[0-9a-fA-F]{6}$/)
            .default("#a9c9ff"),
        overrides: z.record(identifier, finite).default({}),
        interventions: z
            .array(z.object({ at: finite.nonnegative(), values: z.record(identifier, finite), label }).strict())
            .max(256)
            .default([]),
        replacements: z.array(quantitySchema).max(256).default([]),
        removed: z.array(identifier).max(256).default([]),
    })
    .strict();

export const modelDocumentSchema = z
    .object({
        format: z.literal("genesis-model-room"),
        version: z.literal(1),
        id: identifier,
        title: label,
        description: z.string().max(32000).default(""),
        time: z
            .object({ unit: z.string().min(1).max(256), duration: finite.positive(), step: finite.positive() })
            .strict(),
        quantities: z.array(quantitySchema).min(1).max(256),
        scenarios: z.array(scenarioSchema).max(32).default([]),
        subsystems: z
            .array(
                z
                    .object({
                        id: identifier,
                        label,
                        description: z.string().max(8000),
                        quantities: z.array(identifier).min(1).max(256),
                    })
                    .strict()
            )
            .max(64)
            .default([]),
        presentation: z
            .object({
                controls: z.array(identifier).max(32),
                outputs: z.array(identifier).max(32),
                steps: z
                    .array(
                        z
                            .object({
                                title: label,
                                text: z.string().max(8000),
                                scenario: identifier.optional(),
                                time: finite.nonnegative().optional(),
                            })
                            .strict()
                    )
                    .max(64),
            })
            .strict()
            .default({ controls: [], outputs: [], steps: [] }),
    })
    .strict();

export type Quantity = z.infer<typeof quantitySchema>;
export type Scenario = z.infer<typeof scenarioSchema>;
export type ModelDocument = z.infer<typeof modelDocumentSchema>;

export function readModelDocument(input: unknown): ModelDocument {
    const document = modelDocumentSchema.parse(input);

    if (document.presentation.steps.some((step) => step.time !== undefined && step.time > document.time.duration)) {
        throw new Error("A presentation step is outside the model time range.");
    }

    const scenarios = new Set(document.scenarios.map((scenario) => scenario.id));

    if (document.presentation.steps.some((step) => step.scenario !== undefined && !scenarios.has(step.scenario))) {
        throw new Error("A presentation step names an unknown scenario.");
    }

    return document;
}

export function scenarioDocument(
    document: ModelDocument,
    scenarioId?: string
): { document: ModelDocument; scenario?: Scenario } {
    if (!scenarioId) {
        return { document };
    }

    const scenario = document.scenarios.find((entry) => entry.id === scenarioId);

    if (!scenario) {
        throw new Error(`Unknown scenario “${scenarioId}”.`);
    }

    const quantities = new Map(document.quantities.map((quantity) => [quantity.id, quantity]));
    const replaced = new Set<string>();
    for (const replacement of scenario.replacements) {
        if (replaced.has(replacement.id)) {
            throw new Error(`Scenario “${scenario.label}” replaces “${replacement.id}” more than once.`);
        }

        replaced.add(replacement.id);
        quantities.set(replacement.id, replacement);
    }

    for (const id of scenario.removed) {
        if (!quantities.delete(id) || replaced.has(id)) {
            throw new Error(`Scenario “${scenario.label}” has an invalid removal of “${id}”.`);
        }
    }

    return { document: { ...document, quantities: [...quantities.values()] }, scenario };
}
