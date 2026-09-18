import type { Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { PURPOSE_TEMPLATES, parsePurpose, type ScreenPurpose } from "./templates";

export interface ScreenFile {
    path: string;
    text: string;
}

export interface ScreenScore {
    file: string;
    answers: Record<string, number>;
}

export interface ScreenResult {
    purpose: ScreenPurpose;
    scores: ScreenScore[];
    batches: number;
}

const BATCH = 20;
const MAX_CHARS = 4000;

export async function screenFiles(options: {
    files: ScreenFile[];
    purpose: string;
    evaluate: Evaluator;
    signal?: AbortSignal;
}): Promise<ScreenResult> {
    const purpose = parsePurpose(options.purpose);
    const questions = PURPOSE_TEMPLATES[purpose];
    const scores: ScreenScore[] = [];
    const files = options.files.filter((file) => file.text.length > 0);
    let batches = 0;
    for (let offset = 0; offset < files.length; offset += BATCH) {
        const slice = files.slice(offset, offset + BATCH);
        batches += 1;
        const questionMap: Record<string, unknown> = {};
        for (const [index, file] of slice.entries()) {
            for (const question of questions) {
                questionMap[`f${index}_${question.id}`] =
                    question.type === "score"
                        ? {
                              type: "score",
                              instructions: `${question.instructions} File: ${file.path}`,
                              criteria: question.criteria,
                          }
                        : { type: "boolean", instructions: `${question.instructions} File: ${file.path}` };
            }
        }
        const evaluation = await options.evaluate({
            input: {
                state: {
                    purpose,
                    files: slice.map((file) => ({ path: file.path, text: file.text.slice(0, MAX_CHARS) })),
                },
                questions: questionMap,
            },
            signal: options.signal,
        });
        for (const [index, file] of slice.entries()) {
            const answers: Record<string, number> = {};
            for (const question of questions) {
                const answer = evaluation.answers[`f${index}_${question.id}`];
                answers[question.id] =
                    answer?.type === "boolean" ? answer.probability : answer?.type === "score" ? answer.score : 0;
            }
            scores.push({ file: file.path, answers });
        }
    }
    return { purpose, scores, batches };
}
