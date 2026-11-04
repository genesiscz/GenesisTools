import { cancelAskForm, getAskForm, postAskForm } from "@app/question/lib/pending/ask";
import type { AskAnswer, AskFormStatus, CreateAskFormInput } from "@app/question/lib/pending/types";

/** What the assign flow reads back of a question it posted. */
export interface InboxAnswer {
    status: AskFormStatus;
    answers: Record<string, AskAnswer>;
}

/**
 * Where the assign flow asks the owner. The real one is the decision inbox (`question_post` forms: the widget inbox,
 * the dev-dashboard /qa page and a notification); tests pass an in-memory one, since the real one writes a database.
 */
export interface AssignInbox {
    post(input: CreateAskFormInput): Promise<{ id: string }>;
    /** The question's state and answers; null when no question has the id. */
    read(id: string): Promise<InboxAnswer | null>;
    /** Withdraws a question nobody needs to answer any more. */
    cancel(id: string): Promise<void>;
}

/** The decision inbox, reached through the question tool's exported functions only. */
export const decisionInbox: AssignInbox = {
    async post(input) {
        const form = await postAskForm(input, { ambient: false });
        return { id: form.id };
    },
    async read(id) {
        const form = getAskForm(id);
        return form ? { status: form.status, answers: form.answers ?? {} } : null;
    },
    async cancel(id) {
        cancelAskForm(id);
    },
};

export type { AskAnswer, CreateAskFormInput };
