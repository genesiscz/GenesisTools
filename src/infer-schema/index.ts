import { logger, out } from "@app/logger";
import { runTool } from "@app/utils/cli";
import clipboardy from "clipboardy";
import { Command, Option } from "commander";
import { resolveInput } from "./lib/read-input";
import { type OutputFormat, renderSchema } from "./lib/render";

interface Options {
    format: OutputFormat;
    name: string;
    clipboard?: boolean;
}

const program = new Command();

program
    .name("infer-schema")
    .description("Infer a TypeScript interface, JSON Schema, or skeleton from JSON (file or stdin).")
    .argument("[file]", 'JSON file path, or "-" for stdin (also reads stdin when piped)')
    .addOption(
        new Option("-f, --format <format>", "Output format")
            .choices(["typescript", "schema", "skeleton"])
            .default("typescript")
    )
    .option("-n, --name <RootName>", "Root interface name (typescript only)", "Root")
    .option("-c, --clipboard", "Copy the result to the clipboard")
    .action(async (file: string | undefined, options: Options) => {
        if (options.format === "typescript" && !/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(options.name)) {
            out.error(`Invalid root interface name: "${options.name}". It must be a valid TypeScript identifier.`);
            process.exit(1);
        }

        try {
            const { text } = await resolveInput({ arg: file, isTTY: process.stdin.isTTY === true });
            const result = renderSchema({ text, format: options.format, name: options.name });

            if (options.clipboard) {
                try {
                    await clipboardy.write(result);
                    out.log.success("Copied to clipboard");
                } catch (err) {
                    logger.warn({ err }, "infer-schema: failed to copy to clipboard");
                }
            }

            out.result(result);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logger.debug({ err }, "infer-schema: failed");
            out.error(message);
            process.exit(1);
        }
    });

await runTool(program, { tool: "infer-schema" });
