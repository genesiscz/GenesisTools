import { KNOWN_EVENTS } from "./events";
import { type EsMessage, splitPath, valueAsText, valueAtPath } from "./message";

export type FilterOperator = "==" | "!=" | "=~" | "!~";

export interface EventFilter {
    expression: string;
    path: string;
    operator: FilterOperator;
    value: string;
    /** The event a `.event.<name>.…` path reads, so a caller can warn when that event is not captured. */
    eventName?: string;
    test(message: EsMessage): boolean;
}

export class FilterSyntaxError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "FilterSyntaxError";
    }
}

export const FILTER_EXAMPLE = '.event.exec.target.executable.path =~ "zsh"';

const EXPRESSION = /^\s*(\.?[A-Za-z0-9_[\].]+)\s*(==|!=|=~|!~|=)\s*(.*?)\s*$/;

/** A single `=` is read as `==`, as the old tool accepted it. */
const OPERATORS: Record<string, FilterOperator> = { "==": "==", "=": "==", "!=": "!=", "=~": "=~", "!~": "!~" };

function unquote(raw: string): string {
    const first = raw[0];

    if (raw.length >= 2 && (first === '"' || first === "'") && raw.endsWith(first)) {
        return raw.slice(1, -1);
    }

    return raw;
}

/**
 * Compile one `--filter-event` expression: `<path> <op> <value>`, the path in jq-style dot notation.
 *
 * `==` and `!=` compare the whole value as text (numbers and booleans too: `.process.audit_token.euid == 0`),
 * `=~` and `!~` test a regular expression. A path that is missing never equals anything, so `==` and
 * `=~` drop the event and `!=` and `!~` keep it. A syntax error throws {@link FilterSyntaxError} once,
 * before any event is read, instead of letting every event through with a warning per line.
 */
export function compileFilter(expression: string, knownEvents: readonly string[] = KNOWN_EVENTS): EventFilter {
    const match = EXPRESSION.exec(expression);

    if (!match) {
        throw new FilterSyntaxError(
            `Cannot read the filter \`${expression}\`. Write \`<path> <op> <value>\`, where <op> is ==, !=, =~ or !~. Example: ${FILTER_EXAMPLE}`
        );
    }

    const [, path, rawOperator, rawValue] = match;
    const operator = OPERATORS[rawOperator];
    const value = unquote(rawValue);
    const parts = splitPath(path);
    let eventName: string | undefined;

    if (parts[0] === "event" && parts.length > 1) {
        eventName = parts[1];

        if (!knownEvents.includes(eventName)) {
            throw new FilterSyntaxError(
                `The filter path \`${path}\` reads \`.event.${eventName}\`, but eslogger nests every event under its short name, and "${eventName}" is not one. Example: ${FILTER_EXAMPLE}`
            );
        }
    }

    let regex: RegExp | undefined;

    if (operator === "=~" || operator === "!~") {
        try {
            regex = new RegExp(value);
        } catch (error) {
            throw new FilterSyntaxError(
                `The filter \`${expression}\` has an invalid regular expression: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    const test = (message: EsMessage): boolean => {
        const text = valueAsText(valueAtPath(message, path));

        switch (operator) {
            case "==":
                return text !== undefined && text === value;
            case "!=":
                return text === undefined || text !== value;
            case "=~":
                return text !== undefined && (regex?.test(text) ?? false);
            case "!~":
                return text === undefined || !(regex?.test(text) ?? false);
        }
    };

    return { expression, path, operator, value, eventName, test };
}

export function matchesAll(filters: readonly EventFilter[], message: EsMessage): boolean {
    return filters.every((filter) => filter.test(message));
}
