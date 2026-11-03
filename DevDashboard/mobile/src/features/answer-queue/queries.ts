import { type DashboardClient, ENDPOINTS, type PendingAnswerDto, type WaitingQueueDto } from "@dd/contract";
import { queryOptions } from "@tanstack/react-query";
import { type Receipt, receiptOf } from "@/features/answer-queue/units";

/**
 * Answer-queue data layer (F6, D32): the `queryOptions` factory and the write callers over the endpoint table's
 * generic `client.call`. The queue is the Mac's waiting set (`GET /api/qa/waiting`), so its count equals the notch
 * widget's. It polls every 15 s until the live stream (F3) pushes changes.
 */

export const answerQueueKeys = {
    queue: ["answer-queue"] as const,
} as const;

export const QUEUE_INTERVAL_MS = 15_000;

export function answerQueueQuery(client: DashboardClient) {
    return queryOptions<WaitingQueueDto>({
        queryKey: answerQueueKeys.queue,
        queryFn: () => client.call(ENDPOINTS.qaWaiting, {}),
        refetchInterval: QUEUE_INTERVAL_MS,
    });
}

export interface StageInput {
    session: string;
    number: number;
    option?: string;
    text?: string;
    /** The revision the phone showed: a newer post by the agent refuses the stage. */
    expectedRevision: number;
    key: string;
}

/** Stages a pick or a note on one decision; nothing is sent (the pick-then-send model of the notch). */
export function stagePick(client: DashboardClient, { key, ...input }: StageInput) {
    return client.call(ENDPOINTS.qaDecisionsDraft, input, { idempotencyKey: key });
}

/** Sends every staged pick of a session as one message, and says what happened to it. */
export async function sendStaged(
    client: DashboardClient,
    input: { session: string; provider?: string; key: string }
): Promise<Receipt> {
    const send = await client.call(
        ENDPOINTS.qaDecisionsSendDrafts,
        { session: input.session, ...(input.provider ? { provider: input.provider } : {}) },
        { idempotencyKey: input.key }
    );
    return receiptOf(send);
}

/** Answers a pending ask form; the agent that waits on it reads the answer. */
export async function answerForm(
    client: DashboardClient,
    input: { id: string; answers: PendingAnswerDto[]; key: string }
): Promise<Receipt> {
    await client.call(
        ENDPOINTS.qaPendingAnswer,
        { id: input.id, answers: input.answers },
        { idempotencyKey: input.key }
    );
    return { kind: "delivered", detail: null };
}
