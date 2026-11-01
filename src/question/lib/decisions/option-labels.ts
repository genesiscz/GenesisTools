/**
 * A decision's options as every reader shows them. Some agents post bare letters (`options: ["a", "b", "c"]`) and write
 * each option's words only in the prompt, as "a) …" lines; a button that reads "a) a" names nothing (decision 31 of
 * 2026-11-01: the widget drew "a) a", "b) b", and the inbox of every session "a", "b", "c"). One rule, used where a
 * decision is saved (`question_post`) and by every reader (the hub's Inbox, the widget snapshot, the CLI and the
 * delivered answer), so a row saved before the fix reads the same as a new one.
 */

/** One "a) …" line of a prompt, with the indented lines under it that continue it. */
interface OptionLine {
    letter: string;
    text: string;
    /** The line's index in the prompt, and the index after its last continuation line. */
    start: number;
    end: number;
}

/**
 * "a) text", "a. text", "a: text", "(a) text", "**a)** text", "**a) text**", and each of them as a list item ("- a) text").
 * The letter is read case-insensitively; the text is the rest of the line.
 */
const OPTION_LINE = /^\s*(?:[-*+]\s+)?(\*\*|__)?\(?([a-z])[).:](\*\*|__)?(?:\s+(.*))?$/i;

/** An indented line under an option line, with something on it. */
const CONTINUATION = /^(?:\t| {2,})\S/;

function letterAt(index: number): string {
    return String.fromCharCode(97 + index);
}

function optionLine(line: string): { letter: string; text: string } | null {
    const match = OPTION_LINE.exec(line);

    if (!match) {
        return null;
    }

    const [, open, letter = "", close, rest = ""] = match;
    let text = rest.trim();

    // "**a) text**": the bold that opened before the letter closes at the end of the line.
    if (open && !close && text.endsWith(open)) {
        text = text.slice(0, -open.length).trim();
    }

    return { letter: letter.toLowerCase(), text };
}

/**
 * The last list in the prompt that starts at "a)", each letter at its line. An earlier list (findings numbered a, b, c
 * above the question) gives way to the later one, because the options close the question in every posted prompt.
 */
function lastOptionList(lines: string[]): Map<string, OptionLine> {
    let current: Map<string, OptionLine> | null = null;
    let last = new Map<string, OptionLine>();
    let previous: OptionLine | null = null;

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index] ?? "";
        const found = optionLine(line);

        if (!found) {
            if (previous && previous.end === index && CONTINUATION.test(line)) {
                previous.text = `${previous.text}\n${line.trim()}`;
                previous.end = index + 1;
            }

            continue;
        }

        const entry: OptionLine = { ...found, start: index, end: index + 1 };

        if (found.letter === "a") {
            current = new Map([["a", entry]]);
            last = current;
            previous = entry;
            continue;
        }

        const highest = current ? [...current.keys()].at(-1) : undefined;

        if (current && highest && found.letter > highest && found.text) {
            current.set(found.letter, entry);
            previous = entry;
            continue;
        }

        previous = null;
    }

    return last;
}

/** A label without the letter it may start with ("a) Keep it" is "Keep it"); "" for a bare letter. */
function withoutLetter(label: string, letter: string): string {
    const found = optionLine(label);
    return found && found.letter === letter ? found.text : label.trim();
}

/** Whether `label` names nothing beyond its letter: "", "a", "a)", "(a)", "a.", "**a)**". */
export function isBareOptionLabel(label: string, letter: string): boolean {
    const plain = label
        .replace(/\*\*|__/g, "")
        .trim()
        .toLowerCase();
    return plain === "" || plain === letter || withoutLetter(plain, letter) === "";
}

function sameText(a: string, b: string): boolean {
    const plain = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
    return plain(a) === plain(b);
}

/**
 * The options with each bare letter replaced by the text of its line in the prompt ("a) empty it now" makes option a
 * "empty it now"). An option with words of its own is unchanged, and a bare letter with no line keeps its letter.
 */
export function decisionOptionLabels(prompt: string, options: readonly string[]): string[] {
    if (!options.some((option, index) => isBareOptionLabel(option, letterAt(index)))) {
        return [...options];
    }

    const list = lastOptionList(prompt.split("\n"));
    return options.map((option, index) => {
        const letter = letterAt(index);
        const line = list.get(letter);
        return isBareOptionLabel(option, letter) && line?.text ? line.text : option;
    });
}

/**
 * The prompt and the options as a decision card shows them. The options are `decisionOptionLabels`. The prompt leaves
 * out its "a) …" lines when every one of them says exactly what its option's button says, so a card does not print each
 * option twice, once in the question and once on its button. When any line says more than its button (an agent that
 * posted "Keep it" and wrote "a) Keep it: it saves 2 s" in the prompt), every line stays: a list with holes reads
 * worse than a repeat. A prompt that is nothing but the options keeps them.
 */
export function shownDecisionText({ prompt, options }: { prompt: string; options: readonly string[] }): {
    prompt: string;
    options: string[];
} {
    const labels = decisionOptionLabels(prompt, options);
    const lines = prompt.split("\n");
    const list = [...lastOptionList(lines).values()];
    const repeats =
        list.length > 0 &&
        list.every((line) => {
            const index = line.letter.charCodeAt(0) - 97;
            const label = labels[index];
            return label !== undefined && sameText(line.text, withoutLetter(label, line.letter));
        });

    if (!repeats) {
        return { prompt, options: labels };
    }

    const dropped = new Set(list.flatMap((line) => lines.slice(line.start, line.end).map((_, at) => line.start + at)));
    const shown = lines
        .filter((_, index) => !dropped.has(index))
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    return { prompt: shown ? shown : prompt, options: labels };
}
