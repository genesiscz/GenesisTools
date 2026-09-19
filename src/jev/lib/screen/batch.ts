import type { Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { buildQuestion, type EvaluationQuestion, readAnswer } from "./answers";
import { type CustomTemplate, customAsTemplate } from "./custom";
import { evaluateGate, type GateVerdict, mergeGateVerdicts } from "./gate";
import { documentQuestionKey, type PurposeTemplate } from "./templates";

const prof = profiler.scope("jev-verify");

const BATCH = 20;
const MAX_CHARS = 4000;

export interface ScreenFile {
    path: string;
    text: string;
}

export interface ScreenScore {
    file: string;
    answers: Record<string, number | null>;
    gate: GateVerdict;
}

export interface ScreenResult {
    purposes: string[];
    scores: ScreenScore[];
    batches: number;
    gate: GateVerdict;
    missingAnswers: string[];
}

/**
 * Scores files with the selected document templates, 20 files per Jev request.
 *
 * Question keys are `f<indexInBatch>__<templateId>__<questionId>`, so two templates may share a
 * question id (`focus-safety` and `pr-review` both ask `risky`) without one overwriting the other.
 */
export async function screenFiles(options: {
    files: ScreenFile[];
    purposes: PurposeTemplate[];
    custom?: CustomTemplate[];
    task?: string;
    evaluate: Evaluator;
    signal?: AbortSignal;
}): Promise<ScreenResult> {
    const templates = [
        ...options.purposes.filter((template) => template.scope === "document"),
        ...(options.custom ?? []).map(customAsTemplate),
    ];

    if (templates.length === 0) {
        throw new Error(
            "screen needs at least one document template. Claim-only templates (accuracy, contradiction) belong to verify."
        );
    }

    const files = options.files.filter((file) => file.text.trim().length > 0);
    const skipped = options.files.length - files.length;

    if (files.length === 0) {
        throw new Error("Nothing to screen: every input file was empty.");
    }

    logger.info(
        {
            files: files.length,
            skippedEmpty: skipped,
            bytes: files.reduce((total, file) => total + file.text.length, 0),
            templates: templates.map((template) => template.id),
            batchSize: BATCH,
        },
        "Screening files with Jev"
    );
    const scores: ScreenScore[] = [];
    const missingAnswers: string[] = [];
    let batches = 0;
    for (let offset = 0; offset < files.length; offset += BATCH) {
        const slice = files.slice(offset, offset + BATCH);
        batches += 1;
        const evaluation = await prof.measureAsync("batch", () =>
            options.evaluate({
                input: {
                    state: {
                        purposes: templates.map((template) => template.id),
                        task: options.task ?? "",
                        files: slice.map((file) => ({ path: file.path, text: file.text.slice(0, MAX_CHARS) })),
                    },
                    questions: batchQuestions(slice, templates),
                },
                signal: options.signal,
            })
        );
        logger.debug(
            { batch: batches, files: slice.length, model: evaluation.model, usage: evaluation.usage },
            "Jev screen batch answered"
        );
        for (const [index, file] of slice.entries()) {
            const answers: Record<string, number | null> = {};
            for (const template of templates) {
                for (const question of template.questions) {
                    const key = documentQuestionKey(template.id, question.id);
                    const value = readAnswer(evaluation, `f${index}__${key}`);

                    if (value === null) {
                        missingAnswers.push(`${file.path}:${key}`);
                    }

                    answers[key] = value;
                }
            }

            scores.push({
                file: file.path,
                answers,
                gate: evaluateGate({
                    document: answers,
                    selectedTemplateIds: templates.map((template) => template.id),
                    custom: options.custom,
                    subject: file.path,
                }),
            });
        }
    }

    if (missingAnswers.length > 0) {
        logger.warn({ missingAnswers }, "Jev returned no answer for some screen questions");
    }

    const gate = mergeGateVerdicts(scores.map((score) => score.gate));
    logger.info(
        { files: scores.length, batches, block: gate.block, reasons: gate.reasons.map((reason) => reason.id) },
        "Screen complete"
    );
    return { purposes: options.purposes.map((template) => template.id), scores, batches, gate, missingAnswers };
}

function batchQuestions(slice: ScreenFile[], templates: PurposeTemplate[]): Record<string, EvaluationQuestion> {
    const questions: Record<string, EvaluationQuestion> = {};
    for (const [index, file] of slice.entries()) {
        for (const template of templates) {
            for (const question of template.questions) {
                questions[`f${index}__${documentQuestionKey(template.id, question.id)}`] = buildQuestion(
                    question,
                    `File: ${file.path}`
                );
            }
        }
    }

    return questions;
}
