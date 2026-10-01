import { isInteractive, suggestEnumFlag } from "@genesiscz/utils/cli";
import { ui } from "@genesiscz/utils/cli/ui";
import * as p from "@genesiscz/utils/prompts/p";
import type { SourceChoice, SourceName } from "../lib/types";

export const TOOL = "tools wisprflow";
export const SOURCE_CHOICES = ["auto", "local", "mcp"] as const;

const SOURCE_LABEL: Record<SourceName, string> = {
    local: "local Wispr Flow app data on this Mac",
    mcp: "Wispr Flow MCP (api.wisprflow.ai through the local gateway)",
};

/** Every command says which source answered, on stderr so stdout stays the result. */
export function reportSource(source: SourceName, notes: string[] = []): void {
    ui.dim(`source: ${source} (${SOURCE_LABEL[source]})`);

    for (const note of notes) {
        ui.warn(note);
    }
}

export function parseSource(value: unknown, subcommand: string[]): SourceChoice | undefined {
    const given = typeof value === "string" ? value : "auto";

    if ((SOURCE_CHOICES as readonly string[]).includes(given)) {
        return given as SourceChoice;
    }

    ui.err(suggestEnumFlag(TOOL, "--source", SOURCE_CHOICES, { subcommand, given }));
    process.exitCode = 1;
    return undefined;
}

/**
 * An enumerated flag declared `--flag [value]`: a value is checked, a bare flag prompts in a
 * terminal, and anything else prints the possible values with a ready command.
 */
export async function resolveEnum<T extends string>(options: {
    value: unknown;
    fallback: T;
    values: readonly T[];
    flag: string;
    subcommand: string[];
}): Promise<T | undefined> {
    const { value, values, flag, subcommand } = options;

    if (value === undefined) {
        return options.fallback;
    }

    if (typeof value === "string" && (values as readonly string[]).includes(value)) {
        return value as T;
    }

    if (value === true && isInteractive()) {
        const picked = await p.select({
            message: `${flag}`,
            options: values.map((v) => ({ value: v, label: v })),
        });

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

export function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
