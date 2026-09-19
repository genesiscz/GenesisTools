import { logger } from "@genesiscz/utils/logger";
import { CUSTOM_QUESTION_ID, type CustomTemplate } from "./custom";
import { documentQuestionKey } from "./templates";

/**
 * The gate rules table. `--gate` turns a fired rule into exit code 2 on both `screen` and
 * `verify`; without the flag the same reasons are still reported, they just do not change the
 * exit code. A rule only fires when its template was actually selected, so `--purpose relevance`
 * can never block on a `secrets` question nobody asked.
 *
 * `risk` is a score question: the threshold is the criteria index (0 low, 1 review, 2 high), not
 * a probability.
 */
export interface GateRule {
    id: string;
    templateId: string;
    questionId: string;
    threshold: number;
    description: string;
}

export const GATE_RULES: GateRule[] = [
    {
        id: "secrets",
        templateId: "secrets",
        questionId: "secrets",
        threshold: 0.5,
        description: "Credential material in the text under review.",
    },
    {
        id: "prompt-injection",
        templateId: "prompt-injection",
        questionId: "injection",
        threshold: 0.7,
        description: "Instructions aimed at an AI agent in the text under review.",
    },
    {
        id: "risk",
        templateId: "risk",
        questionId: "risk",
        threshold: 2,
        description: "Graded risk reached 'high'.",
    },
];

export interface GateReason {
    id: string;
    key: string;
    templateId: string;
    questionId: string;
    score: number;
    threshold: number;
    description: string;
    /** Set when the gate fired on one file of a directory or diff run. */
    file?: string;
}

export interface GateVerdict {
    block: boolean;
    reasons: GateReason[];
}

export function evaluateGate(options: {
    document: Record<string, number | null>;
    selectedTemplateIds: string[];
    custom?: CustomTemplate[];
    subject?: string;
}): GateVerdict {
    const selected = new Set(options.selectedTemplateIds);
    const reasons: GateReason[] = [];
    for (const rule of GATE_RULES) {
        if (!selected.has(rule.templateId)) {
            continue;
        }

        const key = documentQuestionKey(rule.templateId, rule.questionId);
        const score = options.document[key];

        if (typeof score === "number" && score >= rule.threshold) {
            reasons.push({
                id: rule.id,
                key,
                templateId: rule.templateId,
                questionId: rule.questionId,
                score,
                threshold: rule.threshold,
                description: rule.description,
                file: options.subject,
            });
        }
    }

    for (const template of options.custom ?? []) {
        if (template.gate === undefined) {
            continue;
        }

        const key = documentQuestionKey(template.id, CUSTOM_QUESTION_ID);
        const score = options.document[key];

        if (typeof score === "number" && score >= template.gate) {
            reasons.push({
                id: template.id,
                key,
                templateId: template.id,
                questionId: CUSTOM_QUESTION_ID,
                score,
                threshold: template.gate,
                description: template.summary ?? `Custom gate '${template.id}'.`,
                file: options.subject,
            });
        }
    }

    const verdict = { block: reasons.length > 0, reasons };
    logger.debug(
        { subject: options.subject, block: verdict.block, reasons: reasons.map((reason) => reason.id) },
        "Jev screen gate evaluated"
    );
    return verdict;
}

export function mergeGateVerdicts(verdicts: GateVerdict[]): GateVerdict {
    const reasons: GateReason[] = [];
    for (const verdict of verdicts) {
        reasons.push(...verdict.reasons);
    }

    return { block: reasons.length > 0, reasons };
}
