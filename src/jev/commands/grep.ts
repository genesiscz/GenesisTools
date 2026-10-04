import { selectedProvider } from "@genesiscz/utils/ai/evaluation/cli";
import { suggestCommand } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { ui } from "@genesiscz/utils/cli/ui";
import { formatCost, formatTokens } from "@genesiscz/utils/format";
import { logger, out } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import type { Command } from "commander";
import { printResult, withSigint } from "../lib/cli-output";
import { clearGrepCache } from "../lib/grep/cache";
import type { FilesystemPolicy } from "../lib/grep/filesystem";
import { renderResult } from "../lib/grep/render";
import {
    DEFAULT_GREP_BUDGET,
    type GrepSearchOptions,
    GrepSetupError,
    grepCacheDirectory,
    searchRepository,
} from "../lib/grep/search";
import type { RetrievalResult, RetrievalStatus } from "../lib/grep/types";

const { log } = logger.scoped("jev-grep");
const prof = profiler.scope("jev-grep");

/** Commander's view of the flags. `--no-ignore` and `--no-cache` arrive as `ignore` and `cache`. */
export interface GrepCliOptions {
    hidden?: boolean;
    ignore?: boolean;
    includeDependencies?: boolean;
    includeSensitive?: boolean;
    cache?: boolean;
    concurrency?: string;
    maxSourceBytes?: string;
    budget?: string;
    json?: boolean;
    cacheClear?: boolean;
}

export type GrepCommand = { kind: "cache-clear" } | { kind: "search"; options: GrepSearchOptions; json: boolean };

function nonNegativeInteger(raw: string): number | undefined {
    const value = Number(raw);
    return /^\d+$/.test(raw) && Number.isSafeInteger(value) ? value : undefined;
}

/** Validate the arguments. Throws `GrepSetupError("usage")`; never prompts, TTY or not. */
export function parseGrepCommand(
    question: string | undefined,
    root: string | undefined,
    options: GrepCliOptions,
    cwd: string
): GrepCommand {
    if (options.cacheClear) {
        if (question !== undefined || root !== undefined) {
            throw new GrepSetupError("usage", "--cache-clear takes no question or root.");
        }

        return { kind: "cache-clear" };
    }

    if (!question?.trim()) {
        throw new GrepSetupError(
            "usage",
            `A question is required: ${toolCommand("jev grep", '"<question>"', "[root]")}.`
        );
    }

    let concurrency: number | undefined;
    if (options.concurrency !== undefined) {
        concurrency = nonNegativeInteger(options.concurrency);
        if (!concurrency) {
            throw new GrepSetupError("usage", "--concurrency must be a positive integer.");
        }
    }

    const budget = options.budget === undefined ? DEFAULT_GREP_BUDGET : nonNegativeInteger(options.budget);
    if (budget === undefined) {
        throw new GrepSetupError("usage", "--budget must be a non-negative integer (0 runs the exhaustive search).");
    }

    const maxSourceBytes = options.maxSourceBytes === undefined ? 0 : nonNegativeInteger(options.maxSourceBytes);
    if (maxSourceBytes === undefined) {
        throw new GrepSetupError("usage", "--max-source-bytes must be a non-negative integer (0 means unlimited).");
    }

    const policy: FilesystemPolicy = {};
    if (options.hidden) {
        policy.hidden = true;
    }

    if (options.ignore === false) {
        policy.noIgnore = true;
    }

    if (options.includeDependencies) {
        policy.includeDependencies = true;
    }

    if (options.includeSensitive) {
        policy.includeSensitive = true;
    }

    return {
        kind: "search",
        json: options.json === true,
        options: {
            query: question,
            root: root ?? cwd,
            policy,
            noCache: options.cache === false,
            ...(concurrency === undefined ? {} : { concurrency }),
            maxSourceBytes,
            budget,
        },
    };
}

/** One stderr line for a human at a terminal. The packet never carries it: agents read `counts` in `--json`. */
export function spendLine(result: RetrievalResult): string {
    const { requests, cacheHits, inputTokens = 0, costUsd = 0, unpricedCalls = 0 } = result.counts;
    const unpriced = unpricedCalls ? `; ${unpricedCalls} call(s) had no catalog price` : "";
    return `Jev grep spent ${formatCost(costUsd)} at list price: ${requests} calls, ${formatTokens(inputTokens)} input tokens, ${cacheHits} cache hits${unpriced}.`;
}

export function exitCodeFor(status: RetrievalStatus): number {
    return status === "interrupted" ? 130 : status === "incomplete" ? 2 : 0;
}

function failSetup(error: GrepSetupError, provider: string): void {
    log.debug({ kind: error.kind, error }, "Jev grep could not start");
    const hint =
        error.kind === "usage"
            ? ""
            : ` ${suggestCommand("tools jev", { replaceCommand: ["login", "--provider", provider] })}`;
    ui.err(`${error.message}${hint}`);
    process.exitCode = 1;
}

export function registerGrep(program: Command): void {
    program
        .command("grep")
        .description(
            "Find the source for a behavior when you do not know the symbol or file. Uploads eligible source to Jev. For a known symbol or string, use rg."
        )
        .argument("[question]", "What the code does, as a question")
        .argument(
            "[root]",
            "Directory to search (default: the current directory); use -- before a root starting with -"
        )
        .option("--hidden", "Include dot paths")
        .option("--no-ignore", "Do not apply .gitignore or .ignore")
        .option("--include-dependencies", "Include node_modules, vendor, dist, build and similar directories")
        .option("--include-sensitive", "Include credential filenames such as .env, id_rsa and *.pem")
        .option("--no-cache", "Skip answer-cache reads and writes for this run")
        .option("--concurrency <n>", "In-flight Jev requests (default 32)")
        .option("--max-source-bytes <n>", "Source bytes printed; 0 means unlimited (default 0)")
        .option(
            "--budget <calls>",
            `Jev calls to plan for (default ${DEFAULT_GREP_BUDGET}); 0 runs upstream's exhaustive search, which reads every file`
        )
        .option("--json", "Print the retrieval result as one JSON object instead of the text packet")
        .option("--cache-clear", "Delete ~/.genesis-tools/jev/grep-cache/ and exit")
        .addHelpText(
            "after",
            "\nStdout is the packet, ending with `End context.`; a packet without it was cut. Errors go to stderr.\nExit: 0 complete, 1 bad arguments or credentials, 2 incomplete discovery, 130 interrupted."
        )
        .action(async (question: string | undefined, root: string | undefined, options: GrepCliOptions) => {
            const provider = selectedProvider(program);
            let command: GrepCommand;
            try {
                command = parseGrepCommand(question, root, options, process.cwd());
            } catch (error) {
                if (error instanceof GrepSetupError) {
                    failSetup(error, provider);
                    return;
                }

                throw error;
            }

            if (command.kind === "cache-clear") {
                const directory = grepCacheDirectory();
                const { cleared } = await clearGrepCache(directory);
                ui.info(cleared ? `Cleared ${directory}` : `Nothing to clear in ${directory}`);
                return;
            }

            const search = command;
            // A reader that closed the pipe is gone: stop paying for Jev calls and exit 0, as upstream does.
            const pipe = new AbortController();
            const onPipeError = (error: NodeJS.ErrnoException) => {
                log.debug({ code: error.code }, "Jev grep stdout closed");
                pipe.abort();
                process.exitCode = error.code === "EPIPE" ? 0 : 1;
            };
            process.stdout.on("error", onPipeError);
            try {
                await withSigint(async (interrupt) => {
                    const signal = AbortSignal.any([interrupt, pipe.signal]);
                    if (process.stderr.isTTY && !search.json) {
                        ui.info(
                            `Jev grep: reading ${search.options.root} through ${provider}; eligible source is uploaded.`
                        );
                    }

                    const result = await searchRepository({ options: search.options, provider, signal });
                    if (pipe.signal.aborted) {
                        return;
                    }

                    if (search.json) {
                        printResult(result);
                    } else {
                        out.print(prof.measure("render", () => renderResult(result, search.options.maxSourceBytes)));
                    }

                    if (process.stderr.isTTY) {
                        ui.info(spendLine(result));
                    }

                    process.exitCode = exitCodeFor(result.status);
                });
            } catch (error) {
                if (error instanceof GrepSetupError) {
                    failSetup(error, provider);
                    return;
                }

                throw error;
            } finally {
                process.stdout.off("error", onPipeError);
                prof.summary("jev grep");
            }
        });
}
