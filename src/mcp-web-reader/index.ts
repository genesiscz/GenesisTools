#!/usr/bin/env bun
import { runTool, suggestCommand } from "@genesiscz/utils/cli";
import { pickEnumFlag } from "@genesiscz/utils/cli/enum-flag";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { handleReadmeFlag } from "@genesiscz/utils/readme";
import { Command, InvalidArgumentError } from "commander";
import pc from "picocolors";
import { z } from "zod";
import { DEPTHS, ENGINE_NAMES, isDepth, isEngineName, listEngines, unknownEngineMessage } from "./lib/convert";
import { isReadMode, READ_MODES, readPage } from "./lib/read";

handleReadmeFlag(import.meta.url);

const TOOL = "tools mcp-web-reader";

interface CliOptions {
    url?: string;
    mode: string | boolean;
    engine: string | boolean;
    depth: string | boolean;
    tokens?: number;
    saveTokens?: boolean;
    out?: string;
    headers?: string;
    server?: boolean;
    listEngines?: boolean;
}

const headersSchema = z.record(z.string(), z.string());

function parsePositiveInt(value: string): number {
    const parsed = Number(value);

    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new InvalidArgumentError("expected a positive whole number");
    }

    return parsed;
}

function parseHeaders(raw: string | undefined): Record<string, string> | undefined {
    if (raw === undefined) {
        return undefined;
    }

    const parsed = headersSchema.safeParse(SafeJSON.parse(raw));
    if (!parsed.success) {
        throw new Error(`--headers must be a JSON object of string values: ${z.prettifyError(parsed.error)}`);
    }

    return parsed.data;
}

async function run(urlArg: string | undefined, opts: CliOptions): Promise<void> {
    if (opts.server) {
        const { startMcpServer } = await import("./mcp/server");
        await startMcpServer();
        return;
    }

    if (opts.listEngines) {
        out.println("Available engines:");

        for (const engine of listEngines()) {
            out.println(`  ${pc.cyan(engine.name)}: ${engine.description}`);
        }

        return;
    }

    const flagContext = { tool: TOOL, subcommand: [] };
    const mode = await pickEnumFlag({
        ...flagContext,
        flag: "--mode",
        given: opts.mode,
        values: READ_MODES,
        fallback: "markdown",
        accepts: isReadMode,
    });
    if (!mode) {
        return;
    }

    if (typeof opts.engine === "string" && !isEngineName(opts.engine)) {
        out.printlnErr(unknownEngineMessage(opts.engine));
    }

    const engine = await pickEnumFlag({
        ...flagContext,
        flag: "--engine",
        given: opts.engine,
        values: ENGINE_NAMES,
        fallback: "turndown",
        accepts: isEngineName,
    });
    if (!engine) {
        return;
    }

    const depth = await pickEnumFlag({
        ...flagContext,
        flag: "--depth",
        given: opts.depth,
        values: DEPTHS,
        fallback: "basic",
        accepts: isDepth,
    });
    if (!depth) {
        return;
    }

    const url = urlArg ?? opts.url;
    if (!url) {
        out.log.error("A URL is required (positional or --url).");
        out.printlnErr(suggestCommand(TOOL, { add: ["https://example.com"] }));
        process.exitCode = 1;
        return;
    }

    try {
        const headers = parseHeaders(opts.headers);
        out.log.info(`Fetching ${pc.cyan(url)} (${mode}${mode === "markdown" ? `, ${engine}` : ""})`);
        const result = await readPage({
            url,
            mode,
            engine,
            depth,
            headers,
            maxTokens: opts.tokens,
            saveTokens: opts.saveTokens,
        });

        if (opts.out) {
            await Bun.write(opts.out, result.text);
            out.log.success(
                `Wrote ${opts.out}: ${result.tokens} tokens${result.truncated ? " (truncated)" : ""}` +
                    (result.conversion
                        ? `, ${result.conversion.method} content, ${result.conversion.conversionTime}`
                        : "")
            );
            return;
        }

        out.println(result.text);
    } catch (error) {
        logger.debug({ error, url, mode }, "mcp-web-reader read failed");
        out.log.error(`Failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    }
}

const program = new Command()
    .name("mcp-web-reader")
    .description("Fetch a web page as Markdown, raw HTML or Jina Reader output. Also an MCP server (--server).")
    .argument("[url]", "URL to fetch (or use --url)")
    .option("-u, --url <url>", "Source URL")
    .option("-m, --mode [mode]", `Output: ${READ_MODES.join(" | ")}`, "markdown")
    .option("-e, --engine [engine]", `Markdown engine: ${ENGINE_NAMES.join(" | ")}`, "turndown")
    .option("-d, --depth [depth]", "basic | advanced (advanced adds YAML front matter)", "basic")
    .option("-T, --tokens <n>", "Return at most this many tokens", parsePositiveInt)
    .option("-s, --save-tokens", "Compact whitespace (raw) or code blocks (markdown, jina)")
    .option("-o, --out <path>", "Write to a file instead of stdout")
    .option("--headers <json>", "Extra request headers as a JSON object (not sent in jina mode)")
    .option("--server", "Start the MCP stdio server instead of the CLI")
    .option("--list-engines", "List the markdown engines")
    .action(run);

if (import.meta.main) {
    await runTool(program, { tool: "mcp-web-reader" });
}
