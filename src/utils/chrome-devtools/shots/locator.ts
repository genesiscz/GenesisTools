/**
 * The locator grammar of annotated page shots: strings in Playwright's selector style, parsed here in Node and
 * resolved by our own in-page agent (`in-page/shot-agent.ts`), so a shot needs no Playwright.
 *
 * A chain is steps joined by ` >> `; each step searches inside the elements the step before it found, or filters them:
 *
 *   testid=x         elements whose data-testid is x (`testid^=` prefix, `testid~=` contains)
 *   css=selector     CSS, through open shadow roots
 *   text=Exact       the smallest elements whose whole text is "Exact" (`text~=` contains, any case; `text=/re/i`)
 *   role=dialog      by ARIA role, implicit roles included; `role=heading[name="Zahrada"]` (contains, any case),
 *                    `[name="x"s]` exact, `[name=/re/]`
 *   label=/^Název/   form controls by their label, aria-label or aria-labelledby (`label~=` contains)
 *   has-text=x       keeps the found elements whose text contains x (a filter)
 *   nth=0            keeps one found element by index, -1 is the last (a filter)
 *
 * An array of chains is a union: every member must match, so a renamed test id can never hide inside it.
 */
import { SafeJSON } from "@genesiscz/utils/json";

export type TextMatch =
    | { kind: "exact" | "contains" | "prefix"; text: string }
    | { kind: "regex"; source: string; flags: string };

export type LocatorStep =
    | { engine: "testid"; match: TextMatch }
    | { engine: "css"; selector: string }
    | { engine: "text"; match: TextMatch }
    | { engine: "role"; role: string; name?: TextMatch }
    | { engine: "label"; match: TextMatch }
    | { engine: "has-text"; match: TextMatch }
    | { engine: "nth"; index: number };

export interface LocatorChain {
    /** The chain as written, for messages. */
    source: string;
    steps: LocatorStep[];
}

/** Parsed once at the boundary and sent to the page as is. `source` is what a miss reports. */
export interface Locator {
    source: string;
    chains: LocatorChain[];
}

/** One chain, or a union of chains. */
export type LocatorSource = string | readonly string[];

export class LocatorSyntaxError extends Error {
    override name = "LocatorSyntaxError";
}

const STEP = /^(testid|css|text|role|label|has-text|nth)(\^=|~=|=)([\s\S]*)$/;
const REGEX = /^\/([\s\S]+)\/([dgimsuvy]*)$/;
const ROLE = /^([a-z]+)(?:\[name=([\s\S]+)\])?$/;

function regexOrNull(value: string): TextMatch | null {
    const regex = REGEX.exec(value);
    if (!regex) {
        return null;
    }

    try {
        new RegExp(regex[1], regex[2]);
    } catch (error) {
        throw new LocatorSyntaxError(
            `bad regular expression ${value}: ${error instanceof Error ? error.message : error}`
        );
    }

    return { kind: "regex", source: regex[1], flags: regex[2] };
}

function textMatch(operator: string, value: string, plain: "exact" | "contains"): TextMatch {
    const regex = regexOrNull(value);
    if (regex) {
        return regex;
    }

    if (operator === "^=") {
        return { kind: "prefix", text: value };
    }

    return { kind: operator === "~=" ? "contains" : plain, text: value };
}

/** `"x"` contains (any case), `"x"s` exact, `/re/flags` a regex. */
function roleName(raw: string): TextMatch {
    const regex = regexOrNull(raw);
    if (regex) {
        return regex;
    }

    const exact = raw.endsWith('"s');
    const quoted = exact ? raw.slice(0, -1) : raw.replace(/"i$/, '"');
    if (!quoted.startsWith('"') || !quoted.endsWith('"') || quoted.length < 2) {
        throw new LocatorSyntaxError(`role name must be "quoted", "quoted"s or /regex/, got ${raw}`);
    }

    const text = SafeJSON.parse(quoted, { strict: true });
    if (typeof text !== "string") {
        throw new LocatorSyntaxError(`role name must be a string, got ${raw}`);
    }

    return { kind: exact ? "exact" : "contains", text };
}

function parseStep(raw: string): LocatorStep {
    const step = STEP.exec(raw.trim());
    if (!step) {
        throw new LocatorSyntaxError(
            `unknown step "${raw.trim()}" (engines: testid=, css=, text=, role=, label=, has-text=, nth=)`
        );
    }

    const [, engine, operator, value] = step;
    if (value.length === 0) {
        throw new LocatorSyntaxError(`${engine}${operator} needs a value`);
    }

    switch (engine) {
        case "testid":
            return { engine, match: textMatch(operator, value, "exact") };
        case "css":
            return { engine, selector: value };
        case "text":
            return { engine, match: textMatch(operator, value, "exact") };
        case "label":
            return { engine, match: textMatch(operator, value, "exact") };
        case "has-text":
            return { engine, match: textMatch(operator, value, "contains") };
        case "role": {
            const role = ROLE.exec(value);
            if (!role) {
                throw new LocatorSyntaxError(`role=${value}: expected role=name or role=name[name="…"]`);
            }

            return role[2] === undefined
                ? { engine, role: role[1] }
                : { engine, role: role[1], name: roleName(role[2]) };
        }
        case "nth": {
            const index = Number(value);
            if (!Number.isInteger(index)) {
                throw new LocatorSyntaxError(`nth=${value}: expected an integer`);
            }

            return { engine, index };
        }
        default:
            throw new LocatorSyntaxError(`unknown engine ${engine}`);
    }
}

/**
 * The steps of a chain: ` >> ` separates them only outside a quoted string and a `/regex/` value, so
 * `role=button[name="Next >> page"]` and `text=/a >> b/` stay one step. A quote opens only where a value starts
 * (after `=`, `[`, `(`, `,` or a space), so the apostrophe in `text=Don't` is plain text.
 */
export function splitChain(source: string): string[] {
    const steps: string[] = [];
    let start = 0;
    let quote: string | null = null;
    let regex = false;
    let inClass = false;

    for (let i = 0; i < source.length; i++) {
        const char = source[i];
        if (quote !== null || regex) {
            if (char === "\\") {
                i++;
            } else if (quote !== null && char === quote) {
                quote = null;
            } else if (regex && inClass && char === "]") {
                inClass = false;
            } else if (regex && !inClass && char === "[") {
                inClass = true;
            } else if (regex && !inClass && char === "/") {
                regex = false;
            }

            continue;
        }

        const before = i === 0 ? "" : source[i - 1];
        if ((char === '"' || char === "'") && (before === "" || "=[(, ".includes(before))) {
            quote = char;
        } else if (char === "/" && before === "=") {
            regex = true;
        } else if (source.startsWith(" >> ", i)) {
            steps.push(source.slice(start, i));
            start = i + 4;
            i += 3;
        }
    }

    steps.push(source.slice(start));
    return steps;
}

function parseChain(source: string): LocatorChain {
    const steps = splitChain(source).map(parseStep);
    if (steps[0].engine === "has-text" || steps[0].engine === "nth") {
        throw new LocatorSyntaxError(
            `${steps[0].engine}= filters what a step before it found, so it cannot come first`
        );
    }

    return { source, steps };
}

export function parseLocator(source: LocatorSource): Locator {
    const members = typeof source === "string" ? [source] : [...source];
    const label = members.join(" | ");
    if (members.length === 0) {
        throw new LocatorSyntaxError("an empty union matches nothing");
    }

    try {
        return { source: label, chains: members.map(parseChain) };
    } catch (error) {
        if (error instanceof LocatorSyntaxError) {
            throw new LocatorSyntaxError(`locator "${label}": ${error.message}`);
        }

        throw error;
    }
}
