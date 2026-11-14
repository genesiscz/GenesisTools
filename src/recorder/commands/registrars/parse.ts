import { isInteractive, suggestEnumFlag } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import { type TimeValue, timeSchema } from "@genesiscz/utils/recording-editor/plan";

/** A `--from`/`--to` time: seconds or m:ss, with a plain message instead of a zod dump. */
export function parseTime(raw: string, flag: string): TimeValue {
    const parsed = timeSchema.safeParse(raw);

    if (!parsed.success) {
        throw new Error(`${flag} takes seconds, m:ss or h:mm:ss (got "${raw}")`);
    }

    return parsed.data;
}

/**
 * A closed-value flag declared `--flag [value]`. Returns the value, undefined when the flag was not given (the caller
 * keeps its default), or null when it was bare or invalid and has been dealt with: a terminal picks from the values,
 * anything else gets the possible values and exit code 1. The caller returns on null.
 */
export async function resolveEnumFlag<T extends string>(options: {
    flag: string;
    raw: string | boolean | undefined;
    values: readonly T[];
    subcommand: string[];
    message: string;
    foldCase?: boolean;
}): Promise<T | undefined | null> {
    const { flag, raw, values, subcommand } = options;

    if (raw === undefined) {
        return undefined;
    }

    const wanted = typeof raw === "string" && options.foldCase ? raw.toLowerCase() : raw;
    const found = values.find((value) => value === wanted);

    if (found) {
        return found;
    }

    if (raw === true && isInteractive()) {
        const picked = await p.select<T>({
            message: options.message,
            options: values.map((value) => ({ value, label: value })),
            cancel: "back",
        });

        return p.isCancel(picked) ? null : picked;
    }

    out.printlnErr(
        suggestEnumFlag("tools recorder", flag, values, {
            subcommand,
            given: typeof raw === "string" ? raw : undefined,
        })
    );
    process.exitCode = 1;
    return null;
}
