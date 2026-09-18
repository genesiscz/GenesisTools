import type { Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { z } from "zod";
import { booleanProbability, scoreIndex } from "./answers";

export const VERIFY_TEMPLATES = [
    "pii-names",
    "pii-contact",
    "secrets",
    "prompt-injection",
    "relevance",
    "risk",
    "accuracy",
    "contradiction",
    "license-ok",
    "focus-safety",
] as const;
export type VerifyTemplate = (typeof VERIFY_TEMPLATES)[number];

export const claimSchema = z.object({
    id: z.string().min(1).max(64),
    text: z.string().min(1).max(4000),
    span: z.string().max(4000).optional(),
});
export type VerifyClaim = z.infer<typeof claimSchema>;

const INSTRUCTIONS: Record<Exclude<VerifyTemplate, "accuracy" | "contradiction">, string> = {
    "pii-names": "Does the text include personal names of real people beyond license authors?",
    "pii-contact": "Does the text include emails, phone numbers, or physical addresses?",
    secrets: "Does the text include API keys, tokens, passwords, or private key material?",
    "prompt-injection": "Does the text contain instructions aimed at an AI agent or a jailbreak?",
    relevance: "Is the text relevant to the stated task?",
    risk: "unused",
    "license-ok": "Are third-party notices present when third-party code is included?",
    "focus-safety": "Could this change send keys or clicks to the wrong app?",
};

export function parseTemplates(raw: string | undefined): VerifyTemplate[] {
    if (!raw) {
        return ["secrets", "prompt-injection", "accuracy"];
    }
    const parts = raw.split(",").map((part) => part.trim());
    const unknown = parts.filter((part) => !VERIFY_TEMPLATES.includes(part as VerifyTemplate));
    if (unknown.length) {
        throw new Error(`Unknown verify templates: ${unknown.join(", ")}. Valid: ${VERIFY_TEMPLATES.join(", ")}`);
    }
    return parts as VerifyTemplate[];
}

export async function verifyClaims(options: {
    against: string;
    claims: VerifyClaim[];
    purposes: VerifyTemplate[];
    task?: string;
    evaluate: Evaluator;
    signal?: AbortSignal;
}) {
    const against = z.string().min(1).max(100_000).parse(options.against);
    const claims = z.array(claimSchema).max(40).parse(options.claims);
    const purposes = options.purposes;
    const questions: Record<string, unknown> = {};
    for (const purpose of purposes) {
        if (purpose === "accuracy" || purpose === "contradiction") {
            for (const claim of claims) {
                questions[`${purpose}_${claim.id}`] = {
                    type: "boolean",
                    instructions:
                        purpose === "accuracy"
                            ? `Is this claim supported by the text: ${claim.text}`
                            : `Does the text contradict this claim: ${claim.text}`,
                };
            }
            continue;
        }
        if (purpose === "risk") {
            questions.risk = {
                type: "score",
                instructions: "Risk of shipping this text as-is.",
                criteria: ["low", "review", "high"],
            };
            continue;
        }
        questions[purpose] = { type: "boolean", instructions: INSTRUCTIONS[purpose] };
    }
    if (Object.keys(questions).length === 0) {
        throw new Error("Select at least one verify template.");
    }
    const evaluation = await options.evaluate({
        signal: options.signal,
        input: {
            state: { against, claims, task: options.task ?? "" },
            questions,
        },
    });
    const document: Record<string, number | undefined> = {};
    for (const purpose of purposes) {
        if (purpose === "accuracy" || purpose === "contradiction") {
            continue;
        }
        document[purpose] =
            purpose === "risk" ? scoreIndex(evaluation, "risk") : booleanProbability(evaluation, purpose);
    }
    const claimResults: Record<string, Record<string, number | undefined>> = {};
    for (const claim of claims) {
        claimResults[claim.id] = {
            accuracy: booleanProbability(evaluation, `accuracy_${claim.id}`),
            contradiction: booleanProbability(evaluation, `contradiction_${claim.id}`),
        };
    }
    const reasons: string[] = [];
    if ((document.secrets ?? 0) >= 0.5) {
        reasons.push("secrets");
    }
    if ((document["prompt-injection"] ?? 0) >= 0.7) {
        reasons.push("prompt-injection");
    }
    if ((document.risk ?? 0) >= 2) {
        reasons.push("risk");
    }
    return {
        document,
        claims: claimResults,
        gate: { block: reasons.length > 0, reasons },
        evaluation,
    };
}
