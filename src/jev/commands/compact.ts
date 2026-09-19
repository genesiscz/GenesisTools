import * as p from "@clack/prompts";
import {
    COMPACT_SOURCES,
    type CompactResult,
    type CompactSource,
    compactSession,
    followCompact,
    formatDecisionTable,
} from "@genesiscz/utils/ai/compact";
import { selectedProvider } from "@genesiscz/utils/ai/evaluation/cli";
import { createEvaluator, type Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { isInteractive, suggestEnumFlag } from "@genesiscz/utils/cli";
import { ui } from "@genesiscz/utils/cli/ui";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import type { Command } from "commander";
import { failPlain, printResult, withSigint } from "../lib/cli-output";

const log = logger.child({ component: "jev:compact" });
const prof = profiler.scope("jev-compact");

const INPUT_FORMATS = [
    "Input formats (detected automatically; --source forces one):",
    "  generic JSONL  one {role, content, toolCalls:[{id,name,input,result}]} per line",
    "  blocks JSONL   one Anthropic-style message per line, tool_use / tool_result blocks",
    "  JSON array     a single array of messages in either shape above",
    "  native         a Claude, Codex or Grok transcript (--source claude|codex|grok)",
    "",
    "Output is always generic JSONL, so a compacted transcript parses back.",
].join("\n");

interface CompactCliOptions {
    keep: string;
    pin: string;
    maxResult: string;
    threshold: string;
    keepTokens?: string;
    source?: string | boolean;
    follow?: boolean;
    llm?: boolean;
    summaries?: boolean;
    table?: boolean;
}

async function resolveSource(value: string | boolean | undefined): Promise<CompactSource | null> {
    if (value === undefined) {
        return "auto";
    }

    if (typeof value === "string" && (COMPACT_SOURCES as readonly string[]).includes(value)) {
        return value as CompactSource;
    }

    const given = typeof value === "string" ? value : undefined;
    if (!isInteractive()) {
        ui.raw(suggestEnumFlag("tools jev", "--source", COMPACT_SOURCES, { subcommand: ["compact"], given }));
        return null;
    }

    const picked = await p.select({
        message: "Transcript source",
        options: COMPACT_SOURCES.map((source) => ({ value: source, label: source })),
    });
    return p.isCancel(picked) ? null : (picked as CompactSource);
}

function report(result: CompactResult, options: CompactCliOptions): void {
    if (options.table) {
        ui.section(`decisions (${result.decisions.length})`);
        for (const line of formatDecisionTable(result)) {
            ui.raw(line);
        }

        ui.kv("bytes", `${result.stats.inBytes} → ${result.stats.outBytes}`);
        ui.kv("reduction", result.stats.reduction.toFixed(3));
    }

    printResult(result);
}

export function registerCompact(program: Command): void {
    program
        .command("compact")
        .description("Keep/drop/truncate tool results; never rewrite user or assistant text")
        .argument("[file]", "transcript file, or - for stdin", "-")
        .addHelpText("after", `\n${INPUT_FORMATS}`)
        .option("--keep <n>", "Target share of the input to keep", "0.5")
        .option("--pin <n>", "Trailing messages protected from a drop", "6")
        .option("--max-result <n>", "Head characters kept on a truncated tool result", "800")
        .option("--threshold <n>", "Minimum reduction to accept; below it the input is returned unchanged", "0.25")
        .option("--keep-tokens <n>", "Token budget used as a keep-ratio stand-in")
        .option("--source [kind]", `Transcript source: ${COMPACT_SOURCES.join("|")}`)
        .option("--follow", "Stay attached to the file and re-decide each time it grows")
        .option("--llm", "Let Jev replace the per-call keep/truncate/drop verdicts")
        .option("--summaries", "With --llm: summarize truncated results, gated by a Jev faithfulness check")
        .option("--table", "Print the decision table on stderr")
        .action(async (file: string, options: CompactCliOptions) => {
            const source = await resolveSource(options.source);
            if (!source) {
                process.exitCode = 1;
                return;
            }

            try {
                await withSigint(async (signal) => {
                    const evaluate: Evaluator | undefined = options.llm
                        ? await createEvaluator({ provider: selectedProvider(program) })
                        : undefined;
                    const shared = {
                        source,
                        signal,
                        evaluate,
                        keep: Number(options.keep),
                        pin: Number(options.pin),
                        maxResult: Number(options.maxResult),
                        threshold: Number(options.threshold),
                        keepTokens: options.keepTokens === undefined ? undefined : Number(options.keepTokens),
                        llm: options.llm,
                        summaries: options.summaries,
                    };

                    if (options.follow) {
                        if (file === "-") {
                            throw new Error("compact --follow needs a file path; stdin cannot be followed.");
                        }

                        log.info({ file }, "Following a transcript");
                        await followCompact({
                            ...shared,
                            filePath: file,
                            onResult: (result, event) => {
                                ui.info(`pass ${event.pass}: ${event.sourceBytes} bytes in`);
                                report(result, options);
                            },
                        });
                        return;
                    }

                    const text = file === "-" ? await Bun.stdin.text() : await Bun.file(file).text();
                    if (!text.trim()) {
                        throw new Error("compact needs a transcript on stdin or a file path.");
                    }

                    const result = await compactSession({
                        ...shared,
                        text,
                        filePath: file === "-" ? undefined : file,
                    });
                    report(result, options);
                });
            } catch (error) {
                failPlain(error, { command: "compact", file });
            } finally {
                prof.summary("jev compact");
            }
        });
}
