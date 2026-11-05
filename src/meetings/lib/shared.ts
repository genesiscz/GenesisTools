import { isInteractive, suggestEnumFlag } from "@genesiscz/utils/cli";
import { ui } from "@genesiscz/utils/cli/ui";
import { MeetingsConflictError } from "@genesiscz/utils/meetings/conflict";
import * as p from "@genesiscz/utils/prompts/p";

export const TOOL = "tools meetings";

/**
 * An enumerated flag declared `--flag [value]`: a value is checked, a bare flag prompts in a
 * terminal, and anything else prints the possible values with a ready command.
 */
export async function resolveEnum<T extends string>(options: {
    value: unknown;
    fallback?: T;
    values: readonly T[];
    flag: string;
    subcommand: string[];
}): Promise<T | undefined> {
    const { value, values, flag, subcommand } = options;

    if (value === undefined && options.fallback !== undefined) {
        return options.fallback;
    }

    if (typeof value === "string" && (values as readonly string[]).includes(value)) {
        return value as T;
    }

    if ((value === true || value === undefined) && isInteractive()) {
        const picked = await p.select({ message: flag, options: values.map((v) => ({ value: v, label: v })) });

        if (p.isCancel(picked)) {
            process.exitCode = 1;
            return undefined;
        }

        return picked as T;
    }

    ui.err(suggestEnumFlag(TOOL, flag, values, { subcommand, given: typeof value === "string" ? value : undefined }));
    process.exitCode = 1;
    return undefined;
}

export function fail(message: string): void {
    ui.err(message);
    process.exitCode = 1;
}

/** The error's sentence; a conflict leads with its code (`[export-edited] …`), which the window reads. */
export function errorText(err: unknown): string {
    if (err instanceof MeetingsConflictError) {
        return `[${err.code}] ${err.message}`;
    }

    return err instanceof Error ? err.message : String(err);
}
