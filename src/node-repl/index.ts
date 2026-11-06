#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { runTool, suggestEnumFlag } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { handleReadmeFlag } from "@genesiscz/utils/readme";
import { createBoxTable } from "@genesiscz/utils/table";
import { Command } from "commander";
import { DEFAULT_MAX_OUTPUT_CHARS, ReplEngine } from "./lib/engine";
import { coerceParam, listPresets, readPreset, removePreset, resolveParams, savePreset } from "./lib/presets";
import { parseToolsetList, REPL_TOOLSET_IDS, toolsetCliHelp } from "./lib/toolsets";

handleReadmeFlag(import.meta.url);

const MAX_OUTPUT_HELP = `the most characters a turn returns; longer output is cut with a note naming the file that holds all of it (0: no limit)`;

/** A turn's text on stdout, ended with a newline so the shell prompt starts on its own line (NR21). */
function printTurnText(text: string): void {
    if (text) {
        out.print(text.endsWith("\n") ? text : `${text}\n`);
    }
}

/** `--max-output`, or undefined after an error line for a value that is not a whole number of characters. */
function maxOutputOption(value: string): number | undefined {
    const chars = Number(value);

    if (!Number.isInteger(chars) || chars < 0) {
        logger.error(`--max-output takes a whole number of characters (0: no limit), got "${value}"`);
        process.exitCode = 1;
        return undefined;
    }

    return chars;
}

/** The entries of a `--toolset` list that do not load, so `movies,nope` is refused as "nope". */
function unknownToolsets(value: string): string {
    const entries = value.split(",").map((entry) => entry.trim());
    const unknown = entries.filter((entry) => {
        try {
            parseToolsetList(entry);
            return false;
        } catch (error) {
            logger.debug({ entry, error }, "node-repl --toolset entry does not load");
            return true;
        }
    });
    return (unknown.length > 0 ? unknown : entries).join(",");
}

/** The `--toolset` list, or undefined after printing the known ids for an empty or unknown entry. */
function toolsetsOption(value: string | boolean | undefined, subcommand: string): string[] | undefined {
    if (value === undefined) {
        return [];
    }

    try {
        if (typeof value !== "string" || value.trim() === "") {
            throw new Error("--toolset needs a value");
        }

        return parseToolsetList(value);
    } catch (error) {
        // One message on stderr: the suggestion already names the bad value and the known ones. The subcommand belongs
        // in the tool name, because `subcommand` strips those words from argv and expects them there (NR10).
        logger.debug({ error }, "node-repl --toolset refused");
        const given = typeof value === "string" ? unknownToolsets(value) : undefined;
        out.printlnErr(
            suggestEnumFlag(toolCommand(`node-repl ${subcommand}`), "--toolset", REPL_TOOLSET_IDS, {
                subcommand: [subcommand],
                given,
            })
        );
        process.exitCode = 1;
        return undefined;
    }
}

const program = new Command();
program
    .name("node-repl")
    .description(
        "A persistent JavaScript/TypeScript REPL for agents: bindings survive across calls, top-level await works, images come back as MCP content, and --toolset preloads APIs (computer) once per worker. The same four tools Codex's node_repl exposes, without Codex."
    );

program
    .command("mcp")
    .description("Start the MCP stdio server (tools: js, js_reset, js_add_node_module_dir, turn_ended)")
    .option("--toolset [list]", `comma-separated toolsets to preload: ${REPL_TOOLSET_IDS.join(", ")}`)
    .option("--max-output <chars>", MAX_OUTPUT_HELP, String(DEFAULT_MAX_OUTPUT_CHARS))
    .action(async (opts: { toolset?: string | boolean; maxOutput: string }) => {
        const toolsets = toolsetsOption(opts.toolset, "mcp");
        const maxOutputChars = maxOutputOption(opts.maxOutput);

        if (!toolsets || maxOutputChars === undefined) {
            return;
        }

        const { startMcpServer } = await import("./mcp/server");
        await startMcpServer({ toolsets, maxOutputChars });
    });

program
    .command("run [code]")
    .description("Run one turn and print its output; reads code from --file or stdin when omitted")
    .option("--file <path>", "read the code from a file")
    .option("--timeout <ms>", "wall-clock budget in milliseconds (30000 is 30 s)", "30000")
    .option("--toolset [list]", `comma-separated toolsets to preload: ${REPL_TOOLSET_IDS.join(", ")}`)
    .option("--max-output <chars>", MAX_OUTPUT_HELP, String(DEFAULT_MAX_OUTPUT_CHARS))
    .addHelpText(
        "after",
        [
            "",
            "Inside a turn:",
            "  help()                     the loaded toolsets' docs",
            '  search("cut")              the methods whose name, doc or parameters hold the words',
            '  describe("movies")         the methods of one toolset or object (describe() lists every name)',
            '  describe("movies.Movie.cut")  one method in full: signature, doc, parameters, result',
            "Each `run` is a fresh process, so bindings do not survive between calls; the mcp server keeps them.",
        ].join("\n")
    )
    .action(
        async (
            code: string | undefined,
            opts: { file?: string; timeout: string; toolset?: string | boolean; maxOutput: string }
        ) => {
            // Bun fires a timer scheduled with NaN or a negative delay immediately, so an unchecked
            // --timeout reports "the turn overran" for what is a bad argument.
            const timeout = Number(opts.timeout);

            if (!Number.isFinite(timeout) || timeout <= 0) {
                logger.error(`--timeout must be a positive number of milliseconds, got "${opts.timeout}"`);
                process.exitCode = 1;
                return;
            }

            // A value under a second is almost always meant as seconds ("--timeout 120"): say so, but run as asked.
            if (timeout < 1000) {
                logger.warn(
                    `--timeout is in milliseconds: ${timeout} is ${timeout / 1000} s (for ${timeout} s, pass ${timeout * 1000})`
                );
            }

            const toolsets = toolsetsOption(opts.toolset, "run");
            const maxOutputChars = maxOutputOption(opts.maxOutput);

            if (!toolsets || maxOutputChars === undefined) {
                return;
            }

            // Both used to run the file and drop the code without a word (NR32).
            if (opts.file && code !== undefined) {
                logger.error(`run takes the code as an argument or from --file, not both (--file ${opts.file})`);
                process.exitCode = 1;
                return;
            }

            const source = opts.file ? readFileSync(opts.file, "utf8") : (code ?? (await Bun.stdin.text()));
            const engine = new ReplEngine({ toolsets, maxOutputChars });

            try {
                const result = await engine.run(source, timeout);
                printTurnText(result.text);

                for (const image of result.images) {
                    out.log.info(`image written to ${image.path}`);
                }

                if (!result.ok) {
                    logger.error(result.stack ?? result.error ?? "unknown error");
                    process.exitCode = 1;
                }
            } finally {
                await engine.shutdown();
            }
        }
    );

const preset = program
    .command("preset")
    .description(
        "REPL scripts saved under a name with parameters: save one that worked, list them, run one again with other values (the REPL's presets toolset is the same store)"
    );

preset
    .command("list")
    .description("The saved presets with their params and run counts")
    .option("--json", "as JSON")
    .action((opts: { json?: boolean }) => {
        const presets = listPresets();

        if (opts.json) {
            out.result(presets);
            return;
        }

        if (presets.length === 0) {
            out.println(
                `No presets yet. Save one with ${toolCommand("node-repl preset save <name> --file <script.js>")}.`
            );
            return;
        }

        const table = createBoxTable(["NAME", "TOOLSETS", "PARAMS", "RUNS", "DESCRIPTION"]);

        for (const item of presets) {
            const params = Object.entries(item.params)
                .map(([key, param]) => (param.default === undefined ? `${key}*` : key))
                .join(", ");
            table.push([item.name, item.toolsets.join(", "), params, String(item.runs), item.description ?? ""]);
        }

        out.println(table.toString());
        out.println("* required at every run");
    });

preset
    .command("show <name>")
    .description("One preset's metadata and script")
    .action((name: string) => {
        try {
            const found = readPreset(name);
            out.result({ ...found.meta, folder: found.folder, script: found.script });
        } catch (error) {
            logger.error(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
        }
    });

preset
    .command("save <name>")
    .description("Save a script (the body of an async function that reads `params`) as a named preset")
    .requiredOption("--file <path>", "the script")
    .option("--description <text>", "what it does, for the list")
    .option("--toolset <list>", "the toolsets it needs (by default those the script names, e.g. movies.)")
    .option(
        "--params <json>",
        'its params: {"url":{"type":"string","default":"https://example.org"},"steps":{"type":"number"}} (no default = required)'
    )
    .action((name: string, opts: { file: string; description?: string; toolset?: string; params?: string }) => {
        try {
            const saved = savePreset({
                name,
                input: {
                    script: readFileSync(opts.file, "utf8"),
                    ...(opts.description ? { description: opts.description } : {}),
                    ...(opts.toolset ? { toolsets: parseToolsetList(opts.toolset) } : {}),
                    ...(opts.params ? { params: SafeJSON.parse(opts.params, { strict: true }) } : {}),
                },
                knownToolsets: REPL_TOOLSET_IDS,
            });
            out.printlnErr(`saved preset ${saved.meta.name} in ${saved.folder}`);
            out.result(saved.meta);
        } catch (error) {
            logger.error(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
        }
    });

preset
    .command("run <name>")
    .description("Run a preset with other values, in a fresh REPL with the toolsets it needs")
    .option(
        "--param <key=value>",
        "a value for one param (repeat it); read as the param's type",
        (value: string, previous: string[]) => [...previous, value],
        []
    )
    .option("--timeout <ms>", "wall-clock budget in milliseconds (a demo records for a while)", "600000")
    .action(async (name: string, opts: { param: string[]; timeout: string }) => {
        const timeout = Number(opts.timeout);

        if (!Number.isFinite(timeout) || timeout <= 0) {
            logger.error(`--timeout must be a positive number of milliseconds, got "${opts.timeout}"`);
            process.exitCode = 1;
            return;
        }

        let found: ReturnType<typeof readPreset>;
        const values: Record<string, unknown> = {};

        try {
            found = readPreset(name);

            for (const pair of opts.param) {
                const at = pair.indexOf("=");

                if (at <= 0) {
                    throw new Error(`--param takes key=value (got "${pair}")`);
                }

                const key = pair.slice(0, at);
                const param = found.meta.params[key];

                if (!param) {
                    throw new Error(
                        `preset ${name} has no param ${key}; its params: ${Object.keys(found.meta.params).join(", ") || "none"}`
                    );
                }

                values[key] = coerceParam(key, param, pair.slice(at + 1));
            }

            resolveParams(found.meta, values);
        } catch (error) {
            logger.error(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
            return;
        }

        const engine = new ReplEngine({ toolsets: [...new Set([...found.meta.toolsets, "presets"])] });

        try {
            const result = await engine.run(
                `await presets.run(${SafeJSON.stringify(name)}, ${SafeJSON.stringify(values)})`,
                timeout
            );
            printTurnText(result.text);

            if (!result.ok) {
                logger.error(result.stack ?? result.error ?? "unknown error");
                process.exitCode = 1;
            }
        } finally {
            await engine.shutdown();
        }
    });

preset
    .command("rm <name>")
    .description("Move a preset to the presets folder's .trash/")
    .action((name: string) => {
        try {
            out.println(`moved to ${removePreset(name)}`);
        } catch (error) {
            logger.error(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
        }
    });

program.addHelpText("after", toolsetCliHelp);

await runTool(program, { tool: "node-repl" });
