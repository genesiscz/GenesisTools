import { logger, out } from "@app/logger";
import { parseVariadic, runTool } from "@app/utils/cli";
import { Command } from "commander";
import { convert, formatZoneLine } from "./lib/convert";

interface Options {
    to?: string;
    json?: boolean;
}

const program = new Command();

program
    .name("tz")
    .description("Convert a time across timezones from natural language, e.g. tz '3pm PST in Prague'.")
    .argument("<expr...>", "Natural-language time + zone expression (quoting optional)")
    .option("--to <zones>", "Comma-separated target zones (aliases or IANA names)")
    .option("--json", "Emit a structured JSON array on stdout")
    .action((exprParts: string[], options: Options) => {
        const expr = parseVariadic(exprParts).join(" ").trim();
        const nowMs = Date.now();
        const localZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
        const to = options.to
            ? options.to
                  .split(",")
                  .map((zone) => zone.trim())
                  .filter((zone) => zone.length > 0)
            : undefined;

        let result: ReturnType<typeof convert>;
        try {
            result = convert({ expr, nowMs, localZone, to });
        } catch (err) {
            logger.debug({ err, expr }, "tz conversion failed");
            out.error(err instanceof Error ? err.message : String(err));
            process.exit(1);
        }

        if (options.json) {
            out.result(result.lines);
            return;
        }

        const targetLabel = result.lines.length === 1 ? result.lines[0].label : "default zones";
        out.log.step(`${result.sourceLabel} → ${targetLabel}`);
        for (const line of result.lines) {
            out.println(`  ${formatZoneLine(line)}`);
        }
    });

await runTool(program, { tool: "tz" });
