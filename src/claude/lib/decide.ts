import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DECIDE_PATTERN } from "@genesiscz/utils/browser-router/presets";
import { compileRoutePattern } from "@genesiscz/utils/browser-router/route";
import { PROJECTS_DIR } from "@genesiscz/utils/claude/projects";
import { formatRelativeTime } from "@genesiscz/utils/format";
import { logger } from "@genesiscz/utils/logger";

const SESSION = /^[A-Za-z0-9_-]+$/;
const OPTION = /^[a-z]$/;
const FORM_ID = /^[A-Za-z0-9_-]{1,80}$/;

export interface DecideInput {
    session: string;
    decision: number;
    option: string;
    /** A pending `tools question` form that the answer also closes. */
    question?: string;
}

export function decisionText(decision: number, option: string): string {
    return `DECISION ${decision}: ${option})`;
}

/** The session and number both doors share: a link and a send name the same decision. */
export function validateTarget(input: { session: string; decision: string }): { session: string; decision: number } {
    if (!SESSION.test(input.session)) {
        throw new Error("session id must be letters, numbers, _ or -");
    }

    const decision = Number(input.decision);

    // A digit string past 2^53 rounds to a neighbouring number and would name another decision.
    if (!/^\d+$/.test(input.decision) || !Number.isSafeInteger(decision)) {
        throw new Error("decision must be an integer");
    }

    return { session: input.session, decision };
}

export function validateDecide(input: {
    session: string;
    decision: string;
    option?: string;
    question?: string;
}): DecideInput {
    const target = validateTarget(input);

    if (!input.option || !OPTION.test(input.option)) {
        throw new Error("option must be a single letter a-z");
    }

    // A route passes `--question ""` when the link carries no form id.
    const question = input.question?.trim() ? input.question.trim() : undefined;

    if (question !== undefined && !FORM_ID.test(question)) {
        throw new Error("question must be a form id (letters, numbers, _ or -)");
    }

    return { ...target, option: input.option, ...(question ? { question } : {}) };
}

/** A Claude session exists when its transcript does: `~/.claude/projects/<project>/<id>.jsonl`. */
export function claudeSessionExists(session: string, projectsDir: string = PROJECTS_DIR): boolean {
    if (!SESSION.test(session)) {
        return false;
    }

    let projects: string[];

    try {
        projects = readdirSync(projectsDir);
    } catch (error) {
        logger.warn({ error, projectsDir }, "decide: cannot read the Claude projects folder");
        return false;
    }

    return projects.some((project) => existsSync(join(projectsDir, project, `${session}.jsonl`)));
}

export type DecisionSender = (session: string, text: string) => Promise<boolean | undefined> | boolean | undefined;

/**
 * Types the decision line into the session's pane. A sender that reports `false` (no pane, an
 * ambiguous match, no live surface) typed nothing, so this throws rather than return the line
 * as if it had been sent.
 */
export async function sendDecision(input: DecideInput, send: DecisionSender): Promise<string> {
    const text = decisionText(input.decision, input.option);

    if ((await send(input.session, text)) === false) {
        throw new Error(`DECISION ${input.decision} was not sent to session ${input.session}`);
    }

    return text;
}

export interface DecideDeps {
    sessionExists: (session: string) => boolean;
    send: DecisionSender;
}

/**
 * The whole answer: every value is checked, the session must exist, and only then is the fixed
 * `DECISION <n>: <letter>)` line typed. Nothing from the link reaches the pane as free text.
 */
export async function answerDecision(
    raw: { session: string; decision: string; option?: string; question?: string },
    deps: DecideDeps
): Promise<{ input: DecideInput; text: string }> {
    const input = validateDecide(raw);

    if (!deps.sessionExists(input.session)) {
        throw new Error(`no Claude session ${input.session} on this Mac`);
    }

    const text = await sendDecision(input, deps.send);
    logger.debug({ session: input.session, decision: input.decision, option: input.option }, "decide: answer sent");
    return { input, text };
}

export interface DecisionChoice {
    id: string;
    label: string;
}

/**
 * The choice a letter picks on a question form: an id equal to the letter, then a label or id that
 * starts with `b)`, then the letter's position (a = first). Null when the item offers no such choice.
 */
export function choiceForOption(choices: DecisionChoice[], option: string): DecisionChoice | null {
    const marker = new RegExp(`^\\(?${option}\\)`, "i");
    const direct = choices.find((choice) => choice.id.toLowerCase() === option);

    if (direct) {
        return direct;
    }

    const marked = choices.find((choice) => marker.test(choice.label.trim()) || marker.test(choice.id.trim()));

    if (marked) {
        return marked;
    }

    return choices[option.charCodeAt(0) - "a".charCodeAt(0)] ?? null;
}

export interface QuestionItemShape {
    id: string;
    choices?: DecisionChoice[];
    allowFreeText?: boolean;
}

/**
 * The answer a decision gives a pending question form: the item with choices (else the first), the
 * choice the letter picks, and the fixed decision line as free text when the item takes text.
 */
export function buildQuestionAnswer(
    items: QuestionItemShape[],
    input: Pick<DecideInput, "decision" | "option">
): { itemId: string; selectedChoices?: string[]; freeText?: string } | null {
    const item = items.find((candidate) => candidate.choices?.length) ?? items[0];

    if (!item) {
        return null;
    }

    const choice = choiceForOption(item.choices ?? [], input.option);

    return {
        itemId: item.id,
        ...(choice ? { selectedChoices: [choice.id] } : {}),
        ...(item.allowFreeText ? { freeText: decisionText(input.decision, input.option) } : {}),
    };
}

export function decisionLinks({
    session,
    decision,
    options,
    labels = [],
    question,
}: {
    session: string;
    decision: number;
    options: string[];
    labels?: string[];
    question?: string;
}): string {
    if (question !== undefined && !FORM_ID.test(question)) {
        throw new Error("question must be a form id (letters, numbers, _ or -)");
    }

    const query = question ? `?q=${encodeURIComponent(question)}` : "";
    const routable = compileRoutePattern(DECIDE_PATTERN);

    return options
        .map((option, index) => {
            const letter = option.trim().toLowerCase();

            if (!OPTION.test(letter)) {
                throw new Error(`option must be a single letter, got ${option}`);
            }

            const label = labels[index]?.trim() || letter;
            // A label with brackets would end the markdown link early.
            const safe = label.replace(/[[\]]/g, "");
            const url = `https://genesis.tools/decide/${session}/${decision}/${letter}${query}`;

            // The decide preset bounds the session (64 chars) and the number (6 digits); past them a
            // click is not routed and opens the URL in the browser instead of answering.
            if (!routable.test(url)) {
                throw new Error(
                    `no decide link for session ${session}, decision ${decision}: the router would not route it`
                );
            }

            return `**${letter})** [${safe}](${url})`;
        })
        .join("\n");
}

export interface PickableSession {
    sessionId: string;
    title: string | null;
    project: string | null;
    mtime: number;
}

export interface LinksSessionDeps {
    /** The Claude session running this command, from its hook context. */
    current: () => string | null;
    interactive: () => boolean;
    /** Recent Claude sessions, newest first. */
    recent: () => PickableSession[];
    /** Resolves to the chosen value, or null when the user cancels. */
    select: (choices: { value: string; label: string; hint: string }[]) => Promise<string | null>;
}

/**
 * The session a `decide links` call is for: `--session`, else the Claude session running it, else a
 * picker of recent sessions in a terminal. Without a terminal it refuses, so a link is never guessed.
 */
export async function linksSession(explicit: string | undefined, deps: LinksSessionDeps): Promise<string> {
    const session = explicit ?? deps.current();

    if (session) {
        return session;
    }

    if (!deps.interactive()) {
        throw new Error("no --session, and this command is not running inside a Claude session");
    }

    const sessions = deps.recent();

    if (sessions.length === 0) {
        throw new Error("no --session, and the history index lists no Claude sessions to pick from");
    }

    const picked = await deps.select(
        sessions.map((row) => ({
            value: row.sessionId,
            label: [row.title ?? "(untitled)", row.project].filter(Boolean).join(" · "),
            hint: `${row.sessionId.slice(0, 8)} · ${formatRelativeTime(new Date(row.mtime), { compact: true })}`,
        }))
    );

    if (!picked) {
        throw new Error("no session picked");
    }

    return picked;
}
