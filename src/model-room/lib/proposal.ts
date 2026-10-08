import { randomUUID } from "node:crypto";
import { type Expression, parseExpression } from "@genesiscz/utils/quantities/expression";
import { parseUnit } from "@genesiscz/utils/quantities/units";
import { z } from "zod";
import { compileModel } from "./compiler";
import { type ModelDocument, readModelDocument } from "./document";
import { evaluateDocument } from "./evaluation";

const label = z.string().trim().min(1).max(160);
const identifier = z.string().regex(/^[A-Za-z_][A-Za-z_0-9]{0,63}$/);
const evidenceNumber = z
    .object({
        value: z.number().finite().nullable(),
        sourceQuote: z.string().min(1).max(1000).nullable(),
        question: z.string().max(1000),
    })
    .strict();
const common = {
    id: identifier,
    label,
    unit: z.string().min(1).max(256),
    description: z.string().max(2000),
    seed: evidenceNumber.nullable(),
};

/** A proposal may be incomplete. It is never an executable ModelDocument. */
export const modelProposalSchema = z
    .object({
        format: z.literal("genesis-model-room-proposal"),
        version: z.literal(1),
        title: label,
        explanation: z.string().max(4000),
        time: z
            .object({
                unit: z.enum(["second", "minute", "hour", "day", "week"]),
                duration: evidenceNumber,
                step: evidenceNumber,
            })
            .strict(),
        quantities: z
            .array(
                z.discriminatedUnion("kind", [
                    z.object({ ...common, kind: z.literal("input"), value: evidenceNumber }).strict(),
                    z
                        .object({ ...common, kind: z.literal("formula"), expression: z.string().min(1).max(1024) })
                        .strict(),
                    z
                        .object({
                            ...common,
                            kind: z.literal("stock"),
                            initial: evidenceNumber,
                            derivative: z.string().min(1).max(1024),
                        })
                        .strict(),
                ])
            )
            .min(1)
            .max(24),
        outputs: z.array(identifier).min(1).max(8),
    })
    .strict();

export type ModelProposal = z.infer<typeof modelProposalSchema>;
type EvidenceNumber = z.infer<typeof evidenceNumber>;

export interface ProposalField {
    key: string;
    label: string;
    unit: string;
    question: string;
}

export interface ProposalReview {
    sourceText: string;
    proposal: ModelProposal;
    missing: ProposalField[];
    warnings: string[];
}

function fields(proposal: ModelProposal): Array<ProposalField & { evidence: EvidenceNumber }> {
    const result: Array<ProposalField & { evidence: EvidenceNumber }> = [
        {
            key: "time.duration",
            label: "Duration",
            unit: proposal.time.unit,
            question: proposal.time.duration.question,
            evidence: proposal.time.duration,
        },
        {
            key: "time.step",
            label: "Time step",
            unit: proposal.time.unit,
            question: proposal.time.step.question,
            evidence: proposal.time.step,
        },
    ];

    for (const quantity of proposal.quantities) {
        if (quantity.kind !== "formula") {
            const name = quantity.kind === "input" ? "value" : "initial";
            const evidence = quantity.kind === "input" ? quantity.value : quantity.initial;
            result.push({
                key: `${quantity.id}.${name}`,
                label: quantity.label + (name === "initial" ? " initial value" : ""),
                unit: quantity.unit,
                question: evidence.question,
                evidence,
            });
        }

        if (quantity.seed) {
            result.push({
                key: `${quantity.id}.seed`,
                label: `${quantity.label} history seed`,
                unit: quantity.unit,
                question: quantity.seed.question,
                evidence: quantity.seed,
            });
        }
    }

    return result;
}

function assertNamedCoefficients(expression: Expression): void {
    switch (expression.kind) {
        case "literal":
            if (expression.value !== 0 && expression.value !== 1) {
                throw new Error(
                    "AI coefficients must be named inputs for review; only zero and one may appear inline."
                );
            }
            return;
        case "negate":
            assertNamedCoefficients(expression.value);
            return;
        case "binary":
            assertNamedCoefficients(expression.left);
            assertNamedCoefficients(expression.right);
            return;
        case "call":
            expression.args.forEach(assertNamedCoefficients);
            return;
        case "reference":
        case "lag":
            return;
    }
}

function quoteContainsValue(quote: string, value: number): boolean {
    const numbers = quote.match(/[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/g) ?? [];
    return numbers.some((number) => Number(number) === value);
}

function proposalDocument({
    proposal,
    values,
    reviewed,
}: {
    proposal: ModelProposal;
    values: ReadonlyMap<string, number>;
    reviewed: boolean;
}): ModelDocument {
    const value = (key: string) => {
        const result = values.get(key);

        if (result === undefined) {
            throw new Error(`Resolve the missing value: ${key}`);
        }

        return result;
    };

    return readModelDocument({
        format: "genesis-model-room",
        version: 1,
        id: `proposal_${randomUUID().replaceAll("-", "")}`,
        title: proposal.title,
        description: `${proposal.explanation}\n\nDrafted with AI; assumptions and formulas require human review.`,
        time: {
            unit: proposal.time.unit,
            duration: value("time.duration"),
            step: value("time.step"),
        },
        quantities: proposal.quantities.map((quantity, index) => {
            const evidence =
                quantity.kind === "input" ? quantity.value : quantity.kind === "stock" ? quantity.initial : null;
            const reviewedValue =
                quantity.kind === "formula"
                    ? null
                    : value(quantity.id + (quantity.kind === "input" ? ".value" : ".initial"));
            const commonFields = {
                id: quantity.id,
                label: quantity.label,
                unit: quantity.unit,
                description:
                    quantity.description +
                    (evidence?.sourceQuote ? `\nSource excerpt: ${evidence.sourceQuote}` : "") +
                    (reviewed && reviewedValue !== null
                        ? `\nAuthor-reviewed value: ${reviewedValue} ${quantity.unit}.`
                        : ""),
                provenance: "assumption",
                position: { x: 48 + (index % 4) * 250, y: 48 + Math.floor(index / 4) * 150 },
                ...(quantity.seed ? { seed: value(`${quantity.id}.seed`) } : {}),
            };

            if (quantity.kind === "input") {
                return { ...commonFields, kind: "input", value: value(`${quantity.id}.value`) };
            }

            if (quantity.kind === "stock") {
                return {
                    ...commonFields,
                    kind: "stock",
                    initial: value(`${quantity.id}.initial`),
                    derivative: quantity.derivative,
                };
            }

            return { ...commonFields, kind: "formula", expression: quantity.expression };
        }),
        presentation: {
            controls: proposal.quantities
                .filter((quantity) => quantity.kind === "input")
                .map((quantity) => quantity.id),
            outputs: proposal.outputs,
            steps: [{ title: proposal.title, text: proposal.explanation }],
        },
    });
}

export function inspectModelProposal({ input, sourceText }: { input: unknown; sourceText: string }): ProposalReview {
    if (sourceText.length > 16000) {
        throw new Error("A model request may not exceed 16,000 characters.");
    }

    const proposal = modelProposalSchema.parse(input);
    const warnings = ["AI-drafted relationships are hypotheses. Unit checks do not establish real-world correctness."];
    const missing: ProposalField[] = [];
    const provisional = new Map<string, number>();

    for (const quantity of proposal.quantities) {
        parseUnit({ source: quantity.unit });
        const source =
            quantity.kind === "formula" ? quantity.expression : quantity.kind === "stock" ? quantity.derivative : null;

        if (source) {
            assertNamedCoefficients(parseExpression({ source }));
        }
    }

    for (const field of fields(proposal)) {
        const { evidence } = field;
        const quoted =
            evidence.value !== null &&
            evidence.sourceQuote !== null &&
            sourceText.includes(evidence.sourceQuote) &&
            quoteContainsValue(evidence.sourceQuote, evidence.value);

        if (evidence.value !== null && !quoted) {
            warnings.push(`${field.label}: the proposed number has no matching source excerpt; enter it yourself.`);
            evidence.value = null;
            evidence.sourceQuote = null;
        }

        if (evidence.value === null) {
            const question = field.question.trim() || `What value should ${field.label} use?`;
            evidence.question = question;
            missing.push({ key: field.key, label: field.label, unit: field.unit, question });
        }

        provisional.set(field.key, field.evidence.value ?? 1);
    }

    // Clock placeholders are only for structural checks, never accepted simulation values.
    provisional.set("time.duration", 1);
    provisional.set("time.step", 1);
    const structure = proposalDocument({ proposal, values: provisional, reviewed: false });
    compileModel({ input: structure });

    const quantityIDs = new Set(proposal.quantities.map((quantity) => quantity.id));

    if (
        new Set(proposal.outputs).size !== proposal.outputs.length ||
        proposal.outputs.some((id) => !quantityIDs.has(id))
    ) {
        throw new Error("Proposal outputs must be unique existing quantities.");
    }

    return { sourceText, proposal, missing, warnings };
}

export async function resolveModelProposal({
    input,
    sourceText,
    answers = {},
    signal,
}: {
    input: unknown;
    sourceText: string;
    answers?: Record<string, number>;
    signal?: AbortSignal;
}): Promise<ModelDocument> {
    signal?.throwIfAborted();
    const review = inspectModelProposal({ input, sourceText });
    const allFields = fields(review.proposal);
    const allowed = new Set(allFields.map((field) => field.key));
    const parsedAnswers = z.record(z.string(), z.number().finite()).parse(answers);

    for (const key of Object.keys(parsedAnswers)) {
        if (!allowed.has(key)) {
            throw new Error(`Unknown proposal answer: ${key}`);
        }
    }

    const values = new Map<string, number>();

    for (const field of allFields) {
        const value = Object.hasOwn(parsedAnswers, field.key) ? parsedAnswers[field.key] : field.evidence.value;

        if (value !== null) {
            values.set(field.key, value);
        }
    }

    const document = proposalDocument({ proposal: review.proposal, values, reviewed: true });
    await evaluateDocument({ input: document, control: { signal } });
    signal?.throwIfAborted();
    return document;
}
