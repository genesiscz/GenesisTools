import { suggestEnumFlag } from "@genesiscz/utils/cli/executor";
import { isInteractive } from "@genesiscz/utils/cli/is-interactive";
import { out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";

/**
 * An enumerated flag declared `--flag [value]`: absent → the default; bare in a
 * TTY → a picker; bare elsewhere, or an unknown value → the possible values and
 * a filled-in command line, exit 1 (CLAUDE.md "Enumerated flags").
 */
export async function pickEnumFlag<T extends string>(input: {
    tool: string;
    subcommand: string[];
    flag: string;
    given: string | boolean | undefined;
    values: readonly T[];
    fallback: T;
    accepts: (value: string) => value is T;
}): Promise<T | null> {
    const { flag, given, values, fallback, accepts } = input;
    if (given === undefined || given === false) {
        return fallback;
    }

    if (typeof given === "string" && accepts(given)) {
        return given;
    }

    if (given === true && isInteractive()) {
        const picked = String(
            await p.select({
                message: `${flag} value`,
                options: values.map((value) => ({ value, label: value })),
            })
        );
        return accepts(picked) ? picked : null;
    }

    out.printlnErr(
        suggestEnumFlag(input.tool, flag, values, {
            subcommand: input.subcommand,
            given: typeof given === "string" ? given : undefined,
        })
    );
    process.exitCode = 1;
    return null;
}
