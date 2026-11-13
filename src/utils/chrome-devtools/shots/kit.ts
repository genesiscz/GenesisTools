/**
 * Locator builders for a `.ts` shot book: the names and argument order of the first shot script (`id`, `css`,
 * `text`, `union`), plus the Playwright calls it used (`nth`, `within`, `hasText`, `role`, `label`). Each returns a
 * locator string of the grammar in `locator.ts`, so a book is plain data and a project helper such as
 * `const section = (n: number) => nth(id("section"), n)` is an ordinary function.
 */
import { SafeJSON } from "@genesiscz/utils/json";

function regexText(value: RegExp): string {
    return `/${value.source}/${value.flags}`;
}

/** Elements whose data-testid is `testId`. */
export function id(testId: string): string {
    return `testid=${testId}`;
}

/** Elements whose data-testid starts with `prefix`. */
export function idPrefix(prefix: string): string {
    return `testid^=${prefix}`;
}

export function css(selector: string): string {
    return `css=${selector}`;
}

/** The first element whose whole text is `value` (exact), or contains it in any case (`exact` false), or matches. */
export function text(value: string | RegExp, exact = true): string {
    if (value instanceof RegExp) {
        return `text=${regexText(value)} >> nth=0`;
    }

    return `${exact ? "text=" : "text~="}${value} >> nth=0`;
}

/** Every member must match; the box is the union of all of them. */
export function union(...members: Array<string | readonly string[]>): string[] {
    return members.flatMap((member) => (typeof member === "string" ? [member] : [...member]));
}

/** One of the matches by index; -1 is the last. */
export function nth(locator: string, index: number): string {
    return `${locator} >> nth=${index}`;
}

export function first(locator: string): string {
    return nth(locator, 0);
}

/** `child` searched inside what `parent` found. */
export function within(parent: string, child: string): string {
    return `${parent} >> ${child}`;
}

/** The matches of `locator` whose text contains `value` (any case), or matches it. */
export function hasText(locator: string, value: string | RegExp): string {
    return `${locator} >> has-text=${value instanceof RegExp ? regexText(value) : value}`;
}

/** By ARIA role; `name` contains (any case) unless `exact`, or is a regex. */
export function role(name: string, options: { name?: string | RegExp; exact?: boolean } = {}): string {
    if (options.name === undefined) {
        return `role=${name}`;
    }

    if (options.name instanceof RegExp) {
        return `role=${name}[name=${regexText(options.name)}]`;
    }

    // a JSON string literal is a valid quoted name for the grammar
    return `role=${name}[name=${SafeJSON.stringify(options.name)}${options.exact ? "s" : ""}]`;
}

/** Form controls by their label text: exact, or contains in any case (`exact` false), or a regex. */
export function label(value: string | RegExp, exact = true): string {
    if (value instanceof RegExp) {
        return `label=${regexText(value)}`;
    }

    return `${exact ? "label=" : "label~="}${value}`;
}
