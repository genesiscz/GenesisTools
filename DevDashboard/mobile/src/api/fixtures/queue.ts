import type {
    DecisionRowDto,
    DecisionSendDto,
    PendingAnswerDto,
    WaitingDecisionDto,
    WaitingFormDto,
    WaitingQueueDto,
    WaitingSessionDto,
} from "@dd/contract";

/**
 * The answer queue the fixture wire serves (`GET /api/qa/waiting` and its writes): two agent sessions with invented
 * decisions and one ask form. Stateful like the Mac: a stage changes the decision's pick and revision, a send of the
 * staged picks takes them out of the queue, a form answer takes the form out.
 */

const MINUTE = 60_000;

function ago(minutes: number): string {
    return new Date(Date.now() - minutes * MINUTE).toISOString();
}

function choices(labels: string[], recommended: string | null) {
    return labels.map((label, index) => {
        const id = String.fromCharCode(97 + index);
        return { id, label, rationale: null, recommended: id === recommended };
    });
}

function decision({
    number,
    prompt,
    labels,
    recommended,
}: {
    number: number;
    prompt: string;
    labels: string[];
    recommended: string | null;
}): WaitingDecisionDto {
    return {
        kind: "decision",
        id: `d_${number}`,
        number,
        title: null,
        prompt,
        choices: choices(labels, recommended),
        recommended,
        blocking: true,
        status: "waiting",
        context: null,
        proposal: null,
        reasoning: null,
        draftOption: null,
        draft: null,
        revision: 1,
        at: ago(number * 7),
    };
}

function initialQueue(): WaitingSessionDto[] {
    return [
        {
            sessionId: "s-parser",
            provider: "claude",
            title: "parser work",
            project: "shop",
            counted: 3,
            items: [
                decision({
                    number: 4,
                    prompt: "Keep the parse cache between runs?",
                    labels: ["keep it", "drop it"],
                    recommended: "a",
                }),
                decision({
                    number: 5,
                    prompt: "Which port does the preview server take?",
                    labels: ["3000", "4173", "a free one"],
                    recommended: "c",
                }),
                {
                    kind: "form",
                    id: "ask_fixture",
                    source: "claude",
                    cwd: "/tmp/fixture/shop",
                    questions: [
                        {
                            itemId: "q1",
                            prompt: "Which branch should the fix go on?",
                            choices: choices(["main", "release"], null),
                            multiple: false,
                            freeText: true,
                            required: true,
                        },
                    ],
                    at: ago(3),
                } satisfies WaitingFormDto,
            ],
        },
        {
            sessionId: "s-docs",
            provider: "codex",
            title: "docs pass",
            project: "notes",
            counted: 1,
            items: [
                decision({
                    number: 2,
                    prompt: "Publish the draft now?",
                    labels: ["publish", "wait for review"],
                    recommended: "b",
                }),
            ],
        },
    ];
}

let queue = initialQueue();

function count(session: WaitingSessionDto): WaitingSessionDto {
    return { ...session, counted: session.items.length };
}

export function fixtureQueue(): WaitingQueueDto {
    const sessions = queue.filter((session) => session.items.length > 0).map(count);
    return {
        total: sessions.reduce((sum, session) => sum + session.counted, 0),
        sessions,
        at: new Date().toISOString(),
    };
}

/** Starts the queue over; tests call it so each test sees the same two sessions. */
export function resetFixtureQueue(): void {
    queue = initialQueue();
}

function findDecision(session: string, number: number): WaitingDecisionDto {
    const found = queue
        .find((entry) => entry.sessionId === session)
        ?.items.find((item): item is WaitingDecisionDto => item.kind === "decision" && item.number === number);

    if (!found) {
        throw new Error(`DECISION ${number} is not waiting`);
    }

    return found;
}

export function fixtureDraft(input: {
    session: string;
    number: number;
    option?: string;
    text?: string;
    expectedRevision?: number;
}): DecisionRowDto {
    const item = findDecision(input.session, input.number);

    if (input.expectedRevision !== undefined && input.expectedRevision !== item.revision) {
        throw new Error(`DECISION ${input.number} changed: the agent posted a new text`);
    }

    // As on the Mac (`draftDecision`): an absent pick or note keeps the staged one, and an empty one clears it.
    item.draftOption = input.option === undefined ? item.draftOption : input.option || null;
    item.draft = input.text === undefined ? item.draft : input.text || null;
    item.status = item.draftOption || item.draft ? "drafted" : "waiting";

    return {
        id: item.id,
        sessionId: input.session,
        number: item.number,
        prompt: item.prompt,
        options: item.choices.map((choice) => choice.label),
        state: item.status === "drafted" ? "drafted" : "open",
        revision: item.revision,
        ...(item.recommended ? { recommended: item.recommended } : {}),
    };
}

/**
 * The agent posts a decision again, as the Mac's store does on a re-post: a new revision, and the staged pick and note
 * made on the old text are cleared, so the row waits again.
 */
export function fixtureRepost(session: string, number: number): void {
    const item = findDecision(session, number);
    item.revision += 1;
    item.draftOption = null;
    item.draft = null;
    item.status = "waiting";
}

export function fixtureSendDrafts(input: {
    session: string;
    drafts?: { number: number; expectedRevision?: number }[];
}): DecisionSendDto {
    const session = queue.find((entry) => entry.sessionId === input.session);
    // As on the Mac (`sendDrafts`): with `drafts`, only those decisions' drafts, each at the revision the caller showed.
    const shown = input.drafts ? new Map(input.drafts.map((entry) => [entry.number, entry])) : undefined;
    const decisions = (session?.items ?? []).filter((item): item is WaitingDecisionDto => item.kind === "decision");

    // As on the Mac (`refuseStaleShown`): every shown decision is checked before any draft is picked. A re-post clears
    // the draft, so checking only staged rows would send the other shown drafts as if the reviewed batch still stood.
    for (const entry of input.drafts ?? []) {
        const item = decisions.find((decision) => decision.number === entry.number);

        if (!item) {
            throw new Error(`DECISION ${entry.number} is not waiting in session ${input.session}`);
        }

        if (entry.expectedRevision !== undefined && entry.expectedRevision !== item.revision) {
            throw new Error(`DECISION ${entry.number} changed: the agent posted a new text`);
        }
    }

    const staged = decisions.filter((item) => item.status === "drafted" && (!shown || shown.has(item.number)));

    if (!session || staged.length === 0) {
        throw new Error("nothing to send");
    }

    session.items = session.items.filter((item) => !staged.includes(item as WaitingDecisionDto));

    return {
        numbers: staged.map((item) => item.number),
        text: staged.map((item) => `DECISION ${item.number}: ${item.draftOption ?? ""} ${item.draft ?? ""}`).join("\n"),
        channel: "cmux",
        delivered: true,
        target: "cmux · fixture pane",
    };
}

export function fixtureAnswerForm(id: string, answers: PendingAnswerDto[]): { ok: boolean; entryId?: string } {
    const session = queue.find((entry) => entry.items.some((item) => item.id === id));

    if (!session || answers.length === 0) {
        throw new Error("no answers to send");
    }

    session.items = session.items.filter((item) => item.id !== id);
    return { ok: true, entryId: `qa_${id}` };
}
