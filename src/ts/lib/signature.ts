/**
 * The head the shape helpers below should read: the whole one when the displayed signature was
 * cut at 160 characters, since a cut inside the parameter list drops parameters and the `)`.
 */
export function analysedSignature(symbol: { signature: string; fullSignature?: string }): string {
    return symbol.fullSignature ?? symbol.signature;
}

/** Openers that increase nesting when scanning a signature left to right. */
const OPENERS = new Set(["(", "[", "{", "<"]);
const CLOSERS = new Set([")", "]", "}", ">"]);
const PARAM_TYPE = /:\s*(.+)$/;

/** A closing bracket, but not the `>` of an arrow `=>`, which closes nothing. */
function closesAt(signature: string, index: number): boolean {
    const character = signature[index] as string;

    return CLOSERS.has(character) && !(character === ">" && signature[index - 1] === "=");
}

/** The text between the first `(` and its matching `)`, split on top-level commas. */
function parameterList(signature: string): string[] {
    const open = signature.indexOf("(");

    if (open === -1) {
        return [];
    }

    let depth = 0;
    let current = "";
    const parts: string[] = [];

    for (let index = open; index < signature.length; index += 1) {
        const character = signature[index] as string;

        if (OPENERS.has(character)) {
            depth += 1;

            if (depth === 1) {
                continue;
            }
        } else if (closesAt(signature, index)) {
            depth -= 1;

            if (depth === 0) {
                break;
            }
        } else if (character === "," && depth === 1) {
            parts.push(current);
            current = "";
            continue;
        }

        current += character;
    }

    parts.push(current);

    return parts.map((part) => part.trim()).filter((part) => part !== "");
}

export function parameterCount(signature: string): number {
    return parameterList(signature).length;
}

/** One entry per parameter: its declared type, or `""` when the signature does not state one. */
export function parameterTypes(signature: string): string[] {
    return parameterList(signature).map((part) => part.match(PARAM_TYPE)?.[1]?.replace(/\s+/g, "").trim() ?? "");
}

/**
 * The declared return type, or `""`. Read after the parameter list closes, so a return type
 * that itself contains parentheses or a generic is kept whole.
 */
export function returnType(signature: string): string {
    const open = signature.indexOf("(");

    if (open === -1) {
        return "";
    }

    let depth = 0;
    let close = -1;

    for (let index = open; index < signature.length; index += 1) {
        const character = signature[index] as string;

        if (OPENERS.has(character)) {
            depth += 1;
        } else if (closesAt(signature, index)) {
            depth -= 1;

            if (depth === 0) {
                close = index;
                break;
            }
        }
    }

    if (close === -1) {
        return "";
    }

    const rest = signature.slice(close + 1).trim();

    if (!rest.startsWith(":")) {
        return "";
    }

    return rest
        .slice(1)
        .replace(/=>\s*$/, "")
        .replace(/\{\s*$/, "")
        .replace(/\s+/g, "")
        .trim();
}

function jaccard(left: string[], right: string[]): number {
    const a = new Set(left.filter((value) => value !== ""));
    const b = new Set(right.filter((value) => value !== ""));

    if (a.size === 0 && b.size === 0) {
        return 1;
    }

    if (a.size === 0 || b.size === 0) {
        return 0;
    }

    let shared = 0;

    for (const value of a) {
        if (b.has(value)) {
            shared += 1;
        }
    }

    return shared / (a.size + b.size - shared);
}

/**
 * How alike two declarations look from the outside, from 0 to 1. The return type carries most
 * of the weight, because it is the one part a caller cannot work around.
 *
 * 🛑 This exists because BODY similarity cannot tell "the same helper, rewritten" from "two
 * unrelated things sharing a name". Measured 2026-09-22 on a sibling repo: the canonical `git` and
 * its private copies score 7% to 9% on bodies, and two unrelated `renderMarkdown` functions
 * score 2% — one threshold cannot separate those. On signatures the same pairs score 0.8 to
 * 1.0 and 0.0 to 0.13, which separates cleanly.
 */
export function signatureSimilarity(left: string, right: string): number {
    const sameReturn = returnType(left) !== "" && returnType(left) === returnType(right) ? 1 : 0;

    return Number((sameReturn * 0.6 + jaccard(parameterTypes(left), parameterTypes(right)) * 0.4).toFixed(3));
}
