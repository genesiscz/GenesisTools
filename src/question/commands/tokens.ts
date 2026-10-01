import { readFileSync } from "node:fs";

import { suggestEnumFlag } from "@genesiscz/utils/cli";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, formatDotStatus, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import {
    describeTransclusions,
    formatParamList,
    formatTransclusionHelp,
    TRANSCLUSION_GRAMMAR,
    transclude,
} from "@genesiscz/utils/transclude";
import type { Command } from "commander";
import pc from "picocolors";
import { questionTokenRegistry } from "../lib/transclude";

const FORMATS = ["human", "json"] as const;

function formatFrom(value: unknown): "human" | "json" | null {
    if (value === undefined || value === true) {
        return "human";
    }

    return FORMATS.find((format) => format === value) ?? null;
}

function badFormat(value: unknown, subcommand: string[]): void {
    out.printlnErr(
        suggestEnumFlag("tools question", "--format", FORMATS, {
            subcommand: ["tokens", ...subcommand],
            given: String(value),
        })
    );
    process.exitCode = 1;
}

function renderKinds(): void {
    const registry = questionTokenRegistry();

    if (!process.stdout.isTTY) {
        out.println(formatTransclusionHelp(registry, { indent: "" }));
        return;
    }

    renderCliHeader("Inline tokens", "resolved when a question, decision or todo is saved");
    const table = createBoxTable(["KIND", "PARAMS (* required)", "EXAMPLE"]);

    for (const definition of registry.list()) {
        table.push([pc.white(definition.name), formatParamList(definition), pc.cyan(definition.examples[0])]);
    }

    out.println(table.toString());

    for (const line of TRANSCLUSION_GRAMMAR) {
        out.println(pc.dim(line));
    }

    out.println(pc.dim("Descriptions and every example: tools question tokens --format json"));
}

/**
 * `tools question tokens` lives under `question` because the question store is the only place tokens
 * are resolved today. The grammar and the kinds are `@genesiscz/utils/transclude`, so a second tool
 * adds its own door over the same registry instead of a copy.
 */
export function registerTokensCommand(program: Command): void {
    const tokens = program
        .command("tokens")
        .description("List the inline {{kind …}} tokens a question, decision or todo may carry")
        .option("--format [format]", `${FORMATS.join("|")}`)
        .action((opts: { format?: string | true }) => {
            const format = formatFrom(opts.format);

            if (!format) {
                badFormat(opts.format, []);
                return;
            }

            if (format === "json") {
                out.result(
                    SafeJSON.stringify(
                        { grammar: TRANSCLUSION_GRAMMAR, kinds: describeTransclusions(questionTokenRegistry()) },
                        null,
                        2
                    )
                );
                return;
            }

            renderKinds();
        });

    tokens
        .command("resolve [text...]")
        .description('Preview: resolve the tokens of a text without storing anything ("-" reads stdin)')
        .option("--cwd <path>", "resolve relative paths here (default: the current folder)")
        .option("--format [format]", `${FORMATS.join("|")}`)
        .action(async (words: string[], opts: { cwd?: string; format?: string | true }) => {
            const format = formatFrom(opts.format);

            if (!format) {
                badFormat(opts.format, ["resolve"]);
                return;
            }

            const text = words.length === 1 && words[0] === "-" ? readFileSync(0, "utf8") : words.join(" ");

            if (!text.trim()) {
                out.printlnErr(
                    pc.red(
                        'Give the text to resolve, e.g. tools question tokens resolve \'{{lines path="a.ts" range="1-5"}}\''
                    )
                );
                process.exitCode = 1;
                return;
            }

            const result = await transclude(text, {
                registry: questionTokenRegistry(),
                cwd: opts.cwd ?? process.cwd(),
                // Read-only, like the MCP preview: an image token embeds its original path and copies nothing.
                preview: true,
                callerReports: true,
            });
            const failed = result.tokens.filter((token) => !token.ok);

            if (format === "json") {
                out.result(SafeJSON.stringify(result, null, 2));
            } else {
                out.print(`${result.text}\n`);
                const table = createBoxTable(["KIND", "STATUS", "MS", "CHARS", "TOKEN / REASON"]);

                for (const token of result.tokens) {
                    table.push([
                        pc.white(token.kind),
                        formatDotStatus(
                            token.ok ? "ok" : "err",
                            token.ok ? (token.truncated ? "cut" : "ok") : "failed"
                        ),
                        String(token.ms),
                        String(token.chars),
                        truncateDisplay(token.ok ? token.raw : `${token.raw}: ${token.error}`, 90),
                    ]);
                }

                if (result.tokens.length > 0) {
                    out.printlnErr(table.toString());
                }
            }

            for (const token of failed) {
                out.printlnErr(pc.yellow(`transclude: ${token.raw}: ${token.error}`));
            }

            out.printlnErr(
                pc.dim(`transclude: ${result.tokens.length - failed.length} resolved, ${failed.length} failed`)
            );
            process.exitCode = failed.length > 0 ? 2 : 0;
        });
}
