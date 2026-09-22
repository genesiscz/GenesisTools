/**
 * Sub-tree selection, so a document can be built from part of a large JSON file.
 *
 * Selection is an input concern, not a rendering one, so it lives in its own module and the
 * core never imports it. That keeps `jsonpath`'s parser out of the startup path for callers
 * that only render.
 *
 * JMESPath is the default dialect because `aws --query` and `az --query` already trained
 * every CLI user on it. JSONPath stays available for the `$..deep[*]` idiom it does better.
 */

import { search } from "@jmespath-community/jmespath";
import jsonpath from "jsonpath";

export type SelectDialect = "jmespath" | "jsonpath";

export interface SelectOptions {
    dialect?: SelectDialect;
    /**
     * With JSONPath, return the single match instead of the one-element array. Default `true`,
     * because `$.users` returning `[[...]]` surprises everyone the first time.
     */
    unwrapSingle?: boolean;
}

/**
 * Applies a selection expression to parsed JSON.
 *
 * @throws when the expression does not parse, with the dialect named, because a JMESPath
 *         expression typed into a JSONPath field fails in a way that otherwise reads as a
 *         data problem rather than a syntax one.
 */
export function selectValue(data: unknown, expression: string, options: SelectOptions = {}): unknown {
    const { dialect = "jmespath", unwrapSingle = true } = options;

    if (expression.trim() === "") {
        return data;
    }

    try {
        if (dialect === "jsonpath") {
            const matches = jsonpath.query(data, expression);

            if (unwrapSingle && matches.length === 1) {
                return matches[0];
            }

            return matches;
        }

        // `search` is typed against jmespath's own JSONValue union. The input here is parsed
        // JSON by construction, so this narrows rather than widens.
        return search(data as Parameters<typeof search>[0], expression);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        throw new Error(`json2md: ${dialect} expression failed: ${message}\n  expression: ${expression}`);
    }
}

/** Guesses the dialect from the expression's own syntax, for a single `--select` flag. */
export function guessDialect(expression: string): SelectDialect {
    return expression.trimStart().startsWith("$") ? "jsonpath" : "jmespath";
}
