#!/usr/bin/env bun
import { readFile, stat } from "node:fs/promises";
import { login, logout, requireToken, status } from "@app/apify/lib/auth";
import { ApifyClient, ApifyError, type PageOptions, parseInput, runCosts, sanitizeResult } from "@app/apify/lib/client";
import { summarizeCosts } from "@app/apify/lib/costs";
import { ApifyMcp, PUBLIC_TOOLS } from "@app/apify/lib/mcp";
import { isInteractive, runTool } from "@genesiscz/utils/cli";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import { clackBackend } from "@genesiscz/utils/prompts/p/clack-backend";
import { createBoxTable } from "@genesiscz/utils/table";
import { Command, InvalidArgumentError } from "commander";

const MAX_INPUT_BYTES = 8 * 1024 * 1024;

function numberOption(value: string): number {
    if (value.trim() === "" || !Number.isFinite(Number(value))) {
        throw new InvalidArgumentError("Expected a finite number.");
    }

    return Number(value);
}

function pageOptions(command: Command): PageOptions {
    const options = command.opts();
    return { limit: options.limit, offset: options.offset };
}

function pagination(command: Command): Command {
    return command
        .option("--limit <number>", "Page size, 1 to 1000", numberOption, 20)
        .option("--offset <number>", "Number of records to skip", numberOption, 0);
}

function printResult(command: Command, value: unknown, human?: () => void): void {
    const options = command.optsWithGlobals();
    if (options.json) {
        out.print(`${SafeJSON.stringify(sanitizeResult(value), null, 2)}\n`);
    } else if (!options.silent) {
        if (human) {
            human();
        } else {
            out.print(`${SafeJSON.stringify(sanitizeResult(value), null, 2)}\n`);
        }
    }
}

function textCell(value: unknown): string {
    return String(value ?? "")
        .split("")
        .map((character) => {
            const code = character.charCodeAt(0);
            return code < 32 || (code >= 127 && code <= 159) ? " " : character;
        })
        .join("")
        .slice(0, 160);
}

function printTable(headers: string[], rows: unknown[][]): void {
    const table = createBoxTable(headers);
    for (const row of rows) {
        table.push(row.map(textCell));
    }

    out.println(table.toString());
}

async function authenticated(): Promise<ApifyClient> {
    return new ApifyClient({ token: await requireToken() });
}

async function stdinText(maxBytes: number): Promise<string> {
    if (process.stdin.isTTY) {
        throw new ApifyError("This option requires piped stdin.");
    }

    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        const timer = setTimeout(() => finish(new ApifyError("Timed out reading stdin after 30 seconds.")), 30_000);
        const cleanup = () => {
            clearTimeout(timer);
            process.stdin.off("data", onData);
            process.stdin.off("end", onEnd);
            process.stdin.off("error", onError);
            process.stdin.pause();
        };
        const finish = (error?: Error) => {
            cleanup();

            if (error) {
                reject(error);
            } else {
                resolve(Buffer.concat(chunks).toString("utf8"));
            }
        };
        const onData = (chunk: Buffer | string) => {
            const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += data.length;

            if (bytes > maxBytes) {
                finish(new ApifyError(`Input exceeds the ${maxBytes}-byte limit.`));
                return;
            }

            chunks.push(data);
        };
        const onEnd = () => finish();
        const onError = () => finish(new ApifyError("Could not read stdin."));
        process.stdin.on("data", onData);
        process.stdin.once("end", onEnd);
        process.stdin.once("error", onError);
        process.stdin.resume();
    });
}

async function actorInput(file: string): Promise<Record<string, unknown>> {
    if (file === "-") {
        return parseInput(await stdinText(MAX_INPUT_BYTES));
    }

    try {
        const metadata = await stat(file);
        if (!metadata.isFile() || metadata.size > MAX_INPUT_BYTES) {
            throw new ApifyError("Input must be a regular file no larger than 8 MiB.");
        }

        const contents = await readFile(file, "utf8");
        if (Buffer.byteLength(contents) > MAX_INPUT_BYTES) {
            throw new ApifyError("Input exceeds 8 MiB.");
        }

        return parseInput(contents);
    } catch (error) {
        if (error instanceof ApifyError) {
            throw error;
        }

        throw new ApifyError("Could not read the input file.");
    }
}

export function createApifyCommand(): Command {
    const program = new Command()
        .name("apify")
        .description("Discover Apify Actors, run them with a cost limit, and retrieve results")
        .option("--json", "Print JSON for scripts")
        .option("--silent", "Suppress human output")
        .addHelpText(
            "after",
            "\nStart with login, search, actor schema, then run start. Run start and explicitly enabled Actor MCP access can incur charges."
        );

    program
        .command("login")
        .description("Validate a token and save it in the encrypted vault")
        .option("--token-stdin", "Read the token from stdin instead of a masked prompt")
        .action(async (options, command: Command) => {
            let token: string;
            if (options.tokenStdin) {
                token = await stdinText(8192);
            } else {
                if (!isInteractive()) {
                    throw new ApifyError(
                        "Login needs an interactive terminal or --token-stdin. Never put tokens in arguments."
                    );
                }

                token = await p.password({ message: "Apify API token" });
            }

            const result = await login({ token });
            printResult(command, result, () =>
                out.println(`Saved token for ${textCell(result.user.username ?? result.user.id)}.`)
            );
        });

    program
        .command("status")
        .description("Inspect local credential presence; optionally check it against Apify")
        .option("--check", "GET the authenticated user, without changing saved credentials")
        .action(async (options, command: Command) => {
            const local = status();
            const result = options.check ? { ...local, user: await (await authenticated()).me() } : local;
            printResult(command, result);
        });

    program
        .command("logout")
        .description("Delete only this tool's saved token; does not revoke it at Apify")
        .action(async (_options, command: Command) => printResult(command, await logout()));

    pagination(
        program.command("search <query>").description("Search the public Actor Store, without starting an Actor")
    ).action(async (query: string, _options, command: Command) => {
        const result = await new ApifyClient().search({ query, ...pageOptions(command) });
        printResult(command, result, () => {
            printTable(
                ["ACTOR", "TITLE", "DESCRIPTION"],
                result.items.map((actor) => [
                    actor.username && actor.name ? `${actor.username}/${actor.name}` : actor.id,
                    actor.title,
                    actor.description,
                ])
            );
            out.println(
                `Returned ${result.items.length} of ${result.total}. Next offset: ${result.offset + result.items.length}.`
            );
        });
    });

    const actor = program.command("actor").description("Inspect Actor metadata and published input requirements");
    actor
        .command("show <actor>")
        .description("Get Actor details, including pricing information")
        .action(async (id: string, _options, command: Command) =>
            printResult(command, await (await authenticated()).actor(id))
        );
    actor
        .command("schema <actor>")
        .description("Read the default build's published input schema")
        .action(async (id: string, _options, command: Command) =>
            printResult(command, await (await authenticated()).schema(id))
        );

    const run = program.command("run").description("Start, inspect or abort Actor runs");
    run.command("start <actor>")
        .description("Start one paid Actor run, asynchronously; never retries automatically")
        .requiredOption("--input <file>", "JSON input file, or - for stdin")
        .requiredOption("--max-cost <usd>", "Apify maxTotalChargeUsd, positive USD amount", numberOption)
        .option("--max-items <number>", "Apify pay-per-result item limit", numberOption)
        .option("--timeout <seconds>", "Run duration limit, 1 to 86400", numberOption, 300)
        .option("--memory <mib>", "Power of two, 128 to 32768", numberOption, 128)
        .option("--build <tag>", "Actor build tag or number")
        .option("--wait <seconds>", "Wait 0 to 45 seconds; expiry leaves run active", numberOption, 0)
        .action(async (id: string, options, command: Command) => {
            const input = await actorInput(options.input);
            const result = await (await authenticated()).start({
                actor: id,
                input,
                maxCost: options.maxCost,
                maxItems: options.maxItems,
                timeout: options.timeout,
                memory: options.memory,
                build: options.build,
                waitSecs: options.wait,
            });
            printResult(command, result);
        });
    pagination(run.command("list").description("List a page of recent runs, with recorded USD usage")).action(
        async (_options, command: Command) => {
            const page = await (await authenticated()).runs(pageOptions(command));
            const result = { ...page, costs: runCosts(page.items) };
            printResult(command, result, () => {
                printTable(
                    ["RUN", "STATUS", "USD", "DATASET"],
                    page.items.map((item) => [
                        item.id,
                        item.status,
                        item.usageTotalUsd === undefined ? "unknown" : item.usageTotalUsd.toFixed(6),
                        item.defaultDatasetId,
                    ])
                );
                out.println(
                    `Page recorded usage: $${result.costs.usageTotalUsd.toFixed(6)}; ${result.costs.runsWithoutCost} runs lack cost data.`
                );
                out.println(
                    `Returned ${page.items.length} of ${page.total}. Next offset: ${page.offset + page.items.length}.`
                );
            });
        }
    );
    run.command("show <run-id>")
        .description("Inspect a run and its default dataset ID")
        .action(async (id: string, _options, command: Command) =>
            printResult(command, await (await authenticated()).run(id))
        );
    run.command("abort <run-id>")
        .description("Explicitly request an abort; already incurred charges remain")
        .action(async (id: string, _options, command: Command) =>
            printResult(command, await (await authenticated()).abort(id))
        );

    const dataset = program.command("dataset").description("Retrieve existing Actor output");
    pagination(dataset.command("items <dataset-id>").description("Read one bounded page of dataset items"))
        .option("--fields <names>", "Comma-separated dataset fields to retrieve")
        .option("--omit <names>", "Comma-separated fields to exclude")
        .option("--flatten <names>", "Comma-separated fields to flatten")
        .option("--desc", "Newest items first")
        .option("--no-clean", "Include hidden fields and empty items")
        .action(async (id: string, options, command: Command) => {
            printResult(
                command,
                await (await authenticated()).items({
                    dataset: id,
                    fields: options.fields,
                    omit: options.omit,
                    flatten: options.flatten,
                    desc: options.desc,
                    clean: options.clean,
                    ...pageOptions(command),
                })
            );
        });
    program
        .command("usage")
        .description("Read the account's current monthly platform usage")
        .action(async (_options, command: Command) => printResult(command, await (await authenticated()).usage()));
    program
        .command("costs")
        .description("Sum recorded run usage in a start-time window, with completeness checks")
        .requiredOption("--since <datetime>", "Inclusive start, ISO datetime with timezone")
        .option("--until <datetime>", "Inclusive end, ISO datetime with timezone; defaults to now")
        .option("--page-size <number>", "Runs per request, 1 to 1000", numberOption, 100)
        .option("--max-pages <number>", "Stop after this many pages, 1 to 1000", numberOption, 10)
        .action(async (options, command: Command) => {
            const result = await summarizeCosts({
                source: await authenticated(),
                since: options.since,
                until: options.until ?? new Date().toISOString(),
                pageSize: options.pageSize,
                maxPages: options.maxPages,
            });
            printResult(command, result, () => {
                printTable(
                    ["ACTOR ID", "RUNS", "RECORDED USD", "MISSING COSTS"],
                    result.byActor.map((actor) => [
                        actor.actorId,
                        actor.runs,
                        actor.usageTotalUsd.toFixed(6),
                        actor.runsWithoutCost,
                    ])
                );
                out.println(`Recorded run usage: $${result.recordedUsageTotalUsd.toFixed(6)} before credits.`);
                out.println(
                    `Pagination complete: ${result.paginationComplete}. Recorded cost data complete: ${result.costDataComplete}.`
                );
                out.println("Recent and running runs may still receive accounting updates.");
                out.println(
                    `${result.runsWithoutCost} missing costs; ${result.unfinishedRuns} unfinished runs; ${result.pagesRead} pages read.`
                );
                out.println(result.basis);

                if (!result.paginationComplete) {
                    out.println(
                        `Incomplete: ${result.incompleteReason}. Increase --max-pages and rerun the same window.`
                    );
                }
            });
        });
    program
        .command("recipes")
        .description("Show useful research workflows without making API calls")
        .action((_options, command: Command) =>
            printResult(command, [
                {
                    goal: "Research recurring complaints",
                    search: "reddit scraper",
                    inputHint: "Limit subreddits, search terms and result count; inspect the Actor schema first.",
                },
                {
                    goal: "Turn website documentation into a local corpus",
                    search: "website content crawler",
                    inputHint:
                        "Restrict the domain and page count; export text and source URLs with dataset items --fields.",
                },
                {
                    goal: "Compare public competitor pricing",
                    search: "website scraper",
                    inputHint: "Provide exact public pricing URLs; save dated JSON pages and compare locally.",
                },
                {
                    goal: "Build a public business directory",
                    search: "google maps scraper",
                    inputHint: "Restrict location and categories, inspect pricing, and cap results with --max-items.",
                },
            ])
        );
    const mcp = program
        .command("mcp")
        .description("Current hosted Apify tools with native schemas and structured results");
    mcp.command("tools")
        .description("List public discovery/docs tools without login")
        .action(async (_options, command: Command) => {
            printResult(command, await new ApifyMcp().tools());
        });
    mcp.command("call <tool>")
        .description("Invoke an Apify MCP tool; see README for supported names")
        .requiredOption("--input <file>", "Tool arguments as JSON file, or - for stdin")
        .option("--allow-uncapped-cost", "Acknowledge Actor MCP calls/discovery have no per-call USD cap")
        .option("--allow-report", "Send a report and enable Apify telemetry for the reporting session")
        .action(async (tool: string, options, command: Command) => {
            const args = await actorInput(options.input);
            const token = PUBLIC_TOOLS.some((name) => name === tool) ? undefined : await requireToken();
            printResult(
                command,
                await new ApifyMcp({ token }).invoke({
                    tool,
                    args,
                    allowUncappedCost: options.allowUncappedCost,
                    allowReport: options.allowReport,
                })
            );
        });
    actor
        .command("details <actor>")
        .description("Read README, pricing, metadata, input/output schemas and server HTTP interface via hosted MCP")
        .action(async (id: string, _options, command: Command) =>
            printResult(
                command,
                await new ApifyMcp().invoke({
                    tool: "fetch-actor-details",
                    args: {
                        actor: id,
                        output: {
                            description: true,
                            metadata: true,
                            inputSchema: true,
                            outputSchema: true,
                            pricing: true,
                            readme: true,
                            stats: true,
                            rating: true,
                            serverInterface: true,
                        },
                    },
                })
            )
        );
    const docs = program.command("docs").description("Search Apify and Crawlee documentation without login");
    pagination(docs.command("search <query>"))
        .option("--source [source]", "apify, crawlee-js or crawlee-py", "apify")
        .action(async (query: string, options, command: Command) => {
            if (!["apify", "crawlee-js", "crawlee-py"].includes(options.source)) {
                throw new ApifyError("Use --source apify, --source crawlee-js or --source crawlee-py.");
            }
            const page = pageOptions(command);
            if (
                !Number.isInteger(page.limit) ||
                page.limit < 1 ||
                page.limit > 20 ||
                !Number.isSafeInteger(page.offset) ||
                page.offset < 0
            ) {
                throw new ApifyError("Docs search requires --limit 1 to 20 and a nonnegative --offset.");
            }
            printResult(
                command,
                await new ApifyMcp().invoke({
                    tool: "search-apify-docs",
                    args: { query, docSource: options.source, ...page },
                })
            );
        });
    docs.command("fetch <url>").action(async (url: string, _options, command: Command) => {
        printResult(command, await new ApifyMcp().invoke({ tool: "fetch-apify-docs", args: { url } }));
    });
    program
        .command("kv")
        .description("Read existing key-value store records")
        .command("get <store-id> <key>")
        .action(async (keyValueStoreId: string, recordKey: string, _options, command: Command) => {
            printResult(
                command,
                await new ApifyMcp({ token: await requireToken() }).invoke({
                    tool: "get-key-value-store-record",
                    args: { keyValueStoreId, recordKey },
                })
            );
        });
    actor
        .command("tools <actor>")
        .description("Discover tools on an Actor MCP server, with their full schemas")
        .option("--allow-uncapped-cost", "Acknowledge possible Standby charges without a per-call USD cap")
        .action(async (id: string, options, command: Command) => {
            printResult(
                command,
                await new ApifyMcp({ token: await requireToken() }).invoke({
                    tool: "fetch-actor-mcp-tool-list",
                    args: { actor: id },
                    allowUncappedCost: options.allowUncappedCost,
                })
            );
        });
    actor
        .command("invoke <actor> <tool>")
        .description("Invoke any tool exposed by an Actor MCP server")
        .requiredOption("--input <file>", "Tool arguments as JSON file, or - for stdin")
        .option("--allow-uncapped-cost", "Acknowledge no per-call USD cap exists in this upstream contract")
        .action(async (id: string, tool: string, options, command: Command) => {
            const args = await actorInput(options.input);
            printResult(
                command,
                await new ApifyMcp({ token: await requireToken() }).invoke({
                    tool: "call-actor-mcp-tool",
                    args: { actor: id, tool, arguments: args },
                    allowUncappedCost: options.allowUncappedCost,
                })
            );
        });
    return program;
}

if (import.meta.main) {
    p.setBackend(clackBackend);
    try {
        await runTool(createApifyCommand(), { tool: "apify" });
    } catch (error) {
        const message =
            error instanceof ApifyError
                ? error.message
                : "Apify command failed. Check the vault and network connection.";
        out.printlnErr(`apify: ${message}`);
        process.exitCode = 1;
    }
}
