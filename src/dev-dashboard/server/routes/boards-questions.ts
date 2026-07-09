import { answerQuestion, createQuestion, listQuestions } from "@app/dev-dashboard/lib/boards/boards-store";
import { MAX_ANSWER_LEN, MAX_QUESTION_PROMPT } from "@app/dev-dashboard/lib/boards/compose-types";
import { normalizeOptions } from "@app/dev-dashboard/lib/boards/compose-validate";
import { getBoardsDb } from "@app/dev-dashboard/lib/boards/db";
import { publishBoardEvent } from "@app/dev-dashboard/lib/boards/events";
import type { QuestionDto } from "@app/dev-dashboard/lib/boards/types";
import type { RouteDef } from "@app/dev-dashboard/server/types";
import { logger } from "@app/logger";
import { boardsError } from "./boards-errors";
import { actorFrom } from "./boards-sets";

/** vitrinka's always-present free-text escape (handlers_questions.go) — rendered on every
 *  response, never stored: the answer endpoint accepts any string regardless. */
const OTHER_LABEL = "Other / Něco jiného";

function toQuestionResponse(q: QuestionDto): Record<string, unknown> {
    return { ...q, otherLabel: OTHER_LABEL };
}

async function boardSlugForQuestionId(id: number): Promise<string | null> {
    const row = await getBoardsDb()
        .kysely.selectFrom("board_questions")
        .innerJoin("boards", "boards.id", "board_questions.board_id")
        .select("boards.slug")
        .where("board_questions.id", "=", id)
        .executeTakeFirst();
    return row?.slug ?? null;
}

export function boardsQuestionsRoutes(): RouteDef[] {
    return [
        {
            method: "POST",
            pattern: "/api/boards/:slug/questions",
            handler: async (ctx) => {
                try {
                    const body =
                        (await ctx.readJson<{
                            cardId?: number;
                            prompt?: string;
                            options?: unknown;
                            multiSelect?: boolean;
                        }>()) ?? {};
                    const prompt = (body.prompt ?? "").trim();
                    if (!prompt || prompt.length > MAX_QUESTION_PROMPT) {
                        logger.warn(
                            { slug: ctx.params.slug, promptChars: prompt.length },
                            "boards question: rejected — missing/oversized prompt"
                        );
                        return {
                            kind: "json",
                            status: 400,
                            body: { error: `prompt is required (max ${MAX_QUESTION_PROMPT} chars)` },
                        };
                    }
                    const normalized = normalizeOptions(body.options);
                    if (!normalized.ok) {
                        logger.warn({ slug: ctx.params.slug }, "boards question: rejected — invalid options");
                        return {
                            kind: "json",
                            status: 422,
                            body: {
                                error: "options: 1-12 entries required (the 'Other' escape is added automatically)",
                            },
                        };
                    }
                    const question = await createQuestion(getBoardsDb(), ctx.params.slug, {
                        cardId: body.cardId && body.cardId > 0 ? body.cardId : 0,
                        prompt,
                        options: normalized.options,
                        multi: Boolean(body.multiSelect),
                    });
                    logger.info(
                        {
                            slug: ctx.params.slug,
                            id: question.id,
                            cardId: question.cardId,
                            options: normalized.options.length,
                            multi: Boolean(body.multiSelect),
                        },
                        "boards question: created"
                    );
                    publishBoardEvent(ctx.params.slug, { type: "question", payload: question });
                    return { kind: "json", status: 201, body: toQuestionResponse(question) };
                } catch (err) {
                    return boardsError(err);
                }
            },
        },
        {
            method: "GET",
            pattern: "/api/boards/:slug/questions",
            handler: async (ctx) => {
                try {
                    const questions = await listQuestions(getBoardsDb(), ctx.params.slug);
                    return { kind: "json", status: 200, body: { questions: questions.map(toQuestionResponse) } };
                } catch (err) {
                    return boardsError(err);
                }
            },
        },
        {
            method: "POST",
            pattern: "/api/boards/questions/:id/answer",
            handler: async (ctx) => {
                try {
                    const id = Number(ctx.params.id);
                    const body = (await ctx.readJson<{ answer?: string }>()) ?? {};
                    const answer = (body.answer ?? "").trim();
                    if (!answer || answer.length > MAX_ANSWER_LEN) {
                        return {
                            kind: "json",
                            status: 400,
                            body: { error: `answer is required (max ${MAX_ANSWER_LEN} chars)` },
                        };
                    }
                    const actor = await actorFrom(ctx);
                    const question = await answerQuestion(getBoardsDb(), id, answer, actor);
                    const slug = await boardSlugForQuestionId(id);
                    logger.info(
                        { id, slug, actor, staged: question.staged, answerChars: answer.length },
                        "boards question: answered"
                    );
                    if (slug) {
                        publishBoardEvent(slug, { type: "question", payload: question });
                    }
                    return { kind: "json", status: 200, body: toQuestionResponse(question) };
                } catch (err) {
                    return boardsError(err);
                }
            },
        },
    ];
}
