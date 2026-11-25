import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { MEETING_OUTPUT_NAMES, outputSchemaText, SCHEMA_FORMATS } from "../lib/output-types";
import { fail, resolveEnum } from "../lib/shared";

async function schema(name: string | undefined, opts: { format?: string | boolean }): Promise<void> {
    try {
        const format = await resolveEnum({
            value: opts.format,
            fallback: "ts",
            values: SCHEMA_FORMATS,
            flag: "--format",
            subcommand: ["schema"],
        });

        if (!format) {
            return;
        }

        if (name === undefined) {
            out.result(outputSchemaText());
            return;
        }

        const output = await resolveEnum({
            value: name,
            values: MEETING_OUTPUT_NAMES,
            flag: "<output>",
            subcommand: ["schema"],
        });

        if (!output) {
            return;
        }

        out.result(outputSchemaText({ name: output, format }));
    } catch (error) {
        fail(error);
    }
}

export function registerSchemaCommand(program: Command): void {
    program
        .command("schema")
        .argument("[output]", `the command output: ${MEETING_OUTPUT_NAMES.join(" | ")}; without it, the list`)
        .description("Print the declared types of a command's JSON output, from the source types, never inferred")
        .option("--format [format]", `${SCHEMA_FORMATS.join(" | ")} (default ts)`)
        .action(schema);
}
