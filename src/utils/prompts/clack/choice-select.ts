/**
 * Choice select: one question, answers on top and actions under them, each group under its own heading.
 * Answers are bright. Actions are dim with a coloured glyph. The focused row's hint sits on its own line, so a
 * long hint never wraps beside its label. A header chip, a context block and a key footer are optional.
 *
 * Built on @clack/core `SelectPrompt` like table-select.ts. Esc returns the cancel symbol, exactly like
 * `clack.select`, so a caller tests it with `isCancel`. Interactive only: guard with isInteractive().
 */

import { Writable } from "node:stream";
import { isCancel, SelectPrompt, wrapTextWithPrefix } from "@clack/core";
import pc from "picocolors";
import { type FrameSize, terminalSize, truncateVisible, visibleWidth } from "./table-select";

export interface ChoiceRow<T> {
    value: T;
    label: string;
    hint?: string;
    kind: "answer" | "action";
    /** Actions only: the glyph before the label. */
    glyph?: string;
    /** Actions only: the colour of the glyph and of the focused label. */
    paint?: (text: string) => string;
}

export interface ChoiceSelectOptions<T> {
    /** The question, plain or styled. It wraps. */
    message: string;
    /** A styled line above the question, for example `choiceChip("Q3")` and the progress. */
    header?: string;
    /** Styled lines under the question: the words asked about, with the heard words marked. Each wraps. */
    context?: string[];
    /** A styled line under the context, for a note such as an earlier answer. */
    note?: string;
    rows: ChoiceRow<T>[];
    answersHeading?: string;
    actionsHeading?: string;
    initialValue?: T;
    /** The text of the answered state. Defaults to the focused row's label. */
    formatSubmitted?: (row: ChoiceRow<T>) => string;
    /** The key footer. */
    footer?: string;
}

export const CHOICE_FOOTER = `${pc.dim("↑↓")} move  ${pc.dim("enter")} pick  ${pc.dim("esc")} back`;

export function choiceChip(text: string): string {
    return pc.bgCyan(pc.black(` ${text} `));
}

/** The heard words, marked in a context line. */
export function heardMark(text: string): string {
    return pc.bold(pc.black(pc.bgYellow(` ${text} `)));
}

/** A dim rule with a label: `── answers ────`. */
function rule(label: string, width: number): string {
    return pc.dim(`── ${label} ${"─".repeat(Math.max(2, width - visibleWidth(label) - 4))}`);
}

function wrap(text: string, columns: number, indent: number): string[] {
    const output = Object.assign(new Writable(), { columns });
    const pad = " ".repeat(indent);
    return wrapTextWithPrefix(output, text, pad).split("\n");
}

const BAR = pc.cyan("│");
const GUTTER = pc.cyan("┃");

/**
 * One frame for a state and cursor. Pure, so a test can read it.
 *
 * 🛑 Same redraw contract as table-select.ts: no line wider than the screen, and a frame never taller than the
 * screen. The context goes first when the frame does not fit, then the hint line, then the headings.
 */
export function renderChoiceFrame<T>(
    opts: ChoiceSelectOptions<T>,
    state: string,
    cursor: number,
    size: FrameSize = terminalSize()
): string {
    const width = Math.max(1, size.columns - 1);
    const budget = Math.max(5, size.rows - 1);
    const paint = (lines: string[]): string =>
        lines
            .map((line) => truncateVisible(line, width))
            .slice(0, budget)
            .join("\n");
    const question = wrap(pc.bold(opts.message), size.columns - 1, 3);
    const row = opts.rows[cursor];

    if (state === "submit") {
        const picked = row ? (opts.formatSubmitted ? opts.formatSubmitted(row) : row.label) : "";
        const first = `${pc.green("◇")}  ${question[0]?.slice(3) ?? ""}`;
        const rest = question.slice(1).map((line) => `${pc.gray("│")}  ${line.slice(3)}`);
        return paint([pc.gray("│"), first, ...rest, `${pc.gray("│")}  ${pc.green("✓")} ${pc.bold(pc.cyan(picked))}`]);
    }

    if (state === "cancel") {
        const first = `${pc.red("■")}  ${question[0]?.slice(3) ?? ""}`;
        return paint([pc.gray("│"), first, `${pc.gray("│")}  ${pc.strikethrough(pc.dim("cancelled"))}`]);
    }

    const answers = opts.rows.filter((r) => r.kind === "answer");
    const actions = opts.rows.filter((r) => r.kind === "action");
    const line = (r: ChoiceRow<T>): string => {
        const focused = r === row;
        const pointer = focused ? pc.cyan("❯") : " ";

        if (r.kind === "answer") {
            return focused
                ? `${BAR}  ${pointer} ${pc.green("●")} ${pc.bold(pc.cyan(r.label))}`
                : `${BAR}  ${pointer} ${pc.dim("○")} ${pc.bold(r.label)}`;
        }

        const paintGlyph = r.paint ?? pc.dim;
        const glyph = paintGlyph(r.glyph ?? "·");
        return focused
            ? `${BAR}  ${pointer} ${glyph} ${pc.bold(paintGlyph(r.label))}`
            : `${BAR}  ${pointer} ${glyph} ${pc.dim(r.label)}`;
    };

    const header = opts.header ? [`${pc.cyan("◆")}  ${opts.header}`] : [];
    const askLines = question.map((text, index) =>
        header.length === 0 && index === 0 ? `${pc.cyan("◆")}  ${text.slice(3)}` : `${BAR}  ${text.slice(3)}`
    );
    const contextLines = (opts.context ?? []).flatMap((text) =>
        wrap(text, size.columns - 1, 5).map((part) => `${BAR}  ${GUTTER} ${part.slice(5)}`)
    );
    const note = opts.note ? [`${BAR}  ${opts.note}`] : [];
    const footer = [`${BAR}  ${opts.footer ?? CHOICE_FOOTER}`, pc.cyan("└")];
    const hint = row?.hint ? `${BAR}  ${pc.dim("↳")} ${pc.dim(row.hint)}` : `${BAR}  `;

    const build = (parts: { context: boolean; hint: boolean; headings: boolean }): string[] => {
        const headings = parts.headings;
        return [
            pc.gray("│"),
            ...header,
            ...askLines,
            ...(parts.context ? [...contextLines, ...note] : []),
            ...(headings ? [BAR, `${BAR}  ${rule(opts.answersHeading ?? "answers", 44)}`] : [BAR]),
            ...answers.map(line),
            ...(actions.length > 0
                ? headings
                    ? [`${BAR}  ${rule(opts.actionsHeading ?? "actions", 44)}`]
                    : [BAR]
                : []),
            ...actions.map(line),
            ...(parts.hint ? [BAR, hint] : []),
            ...footer,
        ];
    };

    for (const parts of [
        { context: true, hint: true, headings: true },
        { context: false, hint: true, headings: true },
        { context: false, hint: false, headings: true },
        { context: false, hint: false, headings: false },
    ]) {
        const lines = build(parts);

        if (lines.length <= budget) {
            return paint(lines);
        }
    }

    const ordered = [...answers, ...actions];
    const focused = Math.max(0, ordered.indexOf(row!));
    const room = Math.max(1, budget - 3);
    const start = Math.max(0, Math.min(focused - Math.floor(room / 2), ordered.length - room));
    return paint([
        `${pc.cyan("◆")}  ${question[0]?.slice(3) ?? ""}`,
        ...ordered.slice(start, start + room).map(line),
        ...footer,
    ]);
}

/** Shows the select. Returns the picked row's value, or the cancel symbol on Esc (test it with `isCancel`). */
export async function choiceSelect<T>(opts: ChoiceSelectOptions<T>): Promise<T | symbol> {
    const prompt = new SelectPrompt({
        options: opts.rows.map((row) => ({ value: row.value })),
        initialValue: opts.initialValue ?? opts.rows[0]?.value,
        render() {
            return renderChoiceFrame(opts, this.state, this.cursor, terminalSize());
        },
    });
    const result = await prompt.prompt();

    if (isCancel(result)) {
        return result;
    }

    return result as T;
}
