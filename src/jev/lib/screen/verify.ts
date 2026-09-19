import type { Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { z } from "zod";
import { buildQuestion, type EvaluationQuestion, readAnswer } from "./answers";
import { type CustomTemplate, customAsTemplate } from "./custom";
import { evaluateGate, type GateVerdict } from "./gate";
import {
    CLAIM_QUESTIONS,
    claimQuestionKey,
    documentQuestionKey,
    type PurposeTemplate,
    type TemplateQuestion,
} from "./templates";

const prof = profiler.scope("jev-verify");

const MAX_AGAINST_CHARS = 100_000;
const MAX_CLAIMS = 40;

export interface Claim {
    id: string;
    text: string;
}

export interface ClaimScore {
    id: string;
    text: string;
    supported: number | null;
    contradicted: number | null;
    sensitive: number | null;
}

export interface VerifyResult {
    purposes: string[];
    document: Record<string, number | null>;
    claims: ClaimScore[];
    gate: GateVerdict;
    /** Question keys the evaluator returned no answer for. Non-empty is a defect, not a verdict. */
    missingAnswers: string[];
    evaluation: Awaited<ReturnType<Evaluator>>;
}

const claimSchema = z.object({ id: z.string().min(1).max(64), text: z.string().min(1).max(4000) }).strict();

export function parseClaims(input: string): Claim[] {
    const trimmed = input.trim();

    if (!trimmed) {
        throw new Error("Claims input is empty.");
    }

    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
        const parsed = trimmed.startsWith("[") ? SafeJSON.parse(trimmed) : [SafeJSON.parse(trimmed)];
        return z.array(claimSchema).min(1).max(MAX_CLAIMS).parse(parsed);
    }

    const claims = trimmed
        .split(/\n+/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#"))
        .map((line, index) => ({ id: `c${index + 1}`, text: line.replace(/^[-*]\s+/, "") }));

    if (claims.length === 0) {
        throw new Error("Claims input has no claim lines.");
    }

    return z.array(claimSchema).max(MAX_CLAIMS).parse(claims);
}

/**
 * Judges every claim against the text AND scores the text with the selected document templates.
 *
 * The claim questions do not depend on `--purpose`. PR #410 added them only when the purpose list
 * contained `accuracy` or `contradiction`, so the common `--purpose pii-names,secrets` run
 * produced one empty object per claim (B12). The document templates and the claim questions now
 * travel in the same single request, which is also one Jev call instead of two.
 */
export async function verifyClaims(options: {
    claims: Claim[];
    against: string;
    purposes: PurposeTemplate[];
    custom?: CustomTemplate[];
    task?: string;
    uri?: string;
    evaluate: Evaluator;
    signal?: AbortSignal;
}): Promise<VerifyResult> {
    const against = z.string().min(1).max(MAX_AGAINST_CHARS).parse(options.against);
    const claims = z.array(claimSchema).min(1).max(MAX_CLAIMS).parse(options.claims);
    const documentTemplates = [
        ...options.purposes.filter((template) => template.scope === "document"),
        ...(options.custom ?? []).map(customAsTemplate),
    ];
    const questions: Record<string, EvaluationQuestion> = {};
    for (const template of documentTemplates) {
        for (const question of template.questions) {
            questions[documentQuestionKey(template.id, question.id)] = buildQuestion(question);
        }
    }

    for (const claim of claims) {
        for (const question of CLAIM_QUESTIONS) {
            questions[claimQuestionKey(claim.id, question.id)] = buildQuestion(question, `Claim: ${claim.text}`);
        }
    }

    logger.info(
        {
            claims: claims.length,
            documentTemplates: documentTemplates.map((template) => template.id),
            questions: Object.keys(questions).length,
            againstChars: against.length,
            uri: options.uri,
        },
        "Verifying claims with Jev"
    );
    const evaluation = await prof.measureAsync("evaluate", () =>
        options.evaluate({
            input: {
                state: { against, claims, task: options.task ?? "" },
                questions,
            },
            signal: options.signal,
        })
    );
    const missingAnswers: string[] = [];
    const document = readDocument({ evaluation, templates: documentTemplates, missingAnswers });
    const claimScores = readClaims({ evaluation, claims, missingAnswers });

    if (missingAnswers.length > 0) {
        logger.warn({ missingAnswers, model: evaluation.model }, "Jev returned no answer for some verify questions");
    }

    const gate = evaluateGate({
        document,
        selectedTemplateIds: documentTemplates.map((template) => template.id),
        custom: options.custom,
        subject: options.uri,
    });
    logger.info(
        {
            uri: options.uri,
            block: gate.block,
            reasons: gate.reasons.map((reason) => reason.id),
            missing: missingAnswers.length,
        },
        "Verify complete"
    );
    return {
        purposes: options.purposes.map((template) => template.id),
        document,
        claims: claimScores,
        gate,
        missingAnswers,
        evaluation,
    };
}

function readDocument(options: {
    evaluation: Awaited<ReturnType<Evaluator>>;
    templates: PurposeTemplate[];
    missingAnswers: string[];
}): Record<string, number | null> {
    const document: Record<string, number | null> = {};
    for (const template of options.templates) {
        for (const question of template.questions) {
            const key = documentQuestionKey(template.id, question.id);
            const value = readAnswer(options.evaluation, key);

            if (value === null) {
                options.missingAnswers.push(key);
            }

            document[key] = value;
        }
    }

    return document;
}

function readClaims(options: {
    evaluation: Awaited<ReturnType<Evaluator>>;
    claims: Claim[];
    missingAnswers: string[];
}): ClaimScore[] {
    return options.claims.map((claim) => {
        const read = (question: TemplateQuestion): number | null => {
            const key = claimQuestionKey(claim.id, question.id);
            const value = readAnswer(options.evaluation, key);

            if (value === null) {
                options.missingAnswers.push(key);
            }

            return value;
        };
        const [supported, contradicted, sensitive] = CLAIM_QUESTIONS.map(read);
        return {
            id: claim.id,
            text: claim.text,
            supported: supported ?? null,
            contradicted: contradicted ?? null,
            sensitive: sensitive ?? null,
        };
    });
}
