import { isInteractive, suggestEnumFlag } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";

/**
 * Resolves a flag whose values are a closed set.
 *
 * Commander is told `--flag [value]`, not `--flag <value>`, so an omitted value reaches here
 * instead of exiting with a generic "argument missing" that never lists the values. In a TTY
 * we prompt; otherwise we print the values and the filled-in command.
 *
 * @returns the chosen value, or `undefined` when the caller should stop and exit 1.
 */
export async function resolveEnumFlag<T extends string>(input: {
    given: string | boolean | undefined;
    flag: string;
    values: readonly T[];
    fallback: T;
    label: string;
    subcommand?: string[];
}): Promise<T | undefined> {
    const { given, flag, values, fallback, label, subcommand } = input;

    if (given === undefined) {
        return fallback;
    }

    if (typeof given === "string" && values.includes(given as T)) {
        return given as T;
    }

    if (typeof given === "string" && given !== "") {
        out.log.error(`Unknown value for ${flag}: ${given}`);
        out.println(suggestEnumFlag("tools json2md", flag, values, { subcommand, given }));

        return undefined;
    }

    if (!isInteractive()) {
        out.println(suggestEnumFlag("tools json2md", flag, values, { subcommand }));

        return undefined;
    }

    const picked = await p.select({
        message: label,
        options: values.map((value) => ({ value, label: value })),
        initialValue: fallback,
    });

    if (p.isCancel(picked)) {
        return undefined;
    }

    // The prompt facade returns a widened value, so membership is re-checked rather than cast.
    return typeof picked === "string" && values.includes(picked as T) ? (picked as T) : undefined;
}

/** Parses `key=value` pairs from repeatable flags such as `--meta`. */
export function parsePairs(values: string[] | undefined): Record<string, string> {
    const result: Record<string, string> = {};

    for (const entry of values ?? []) {
        const separator = entry.indexOf("=");

        if (separator === -1) {
            throw new Error(`Expected key=value, got: ${entry}`);
        }

        result[entry.slice(0, separator).trim()] = entry.slice(separator + 1);
    }

    return result;
}

/** Parses a column spec list: `key`, `key:Header`, or `key:Header:right`. */
export function parseColumns(
    value: string | undefined
): Array<{ key: string; header?: string; align?: "left" | "center" | "right" }> | undefined {
    if (!value) {
        return undefined;
    }

    return value.split(",").map((entry) => {
        const [key, header, align] = entry.split(":").map((part) => part.trim());

        if (!key) {
            throw new Error(`Empty column in --columns: ${value}`);
        }

        const spec: { key: string; header?: string; align?: "left" | "center" | "right" } = { key };

        if (header) {
            spec.header = header;
        }

        if (align === "left" || align === "center" || align === "right") {
            spec.align = align;
        }

        return spec;
    });
}
