#!/usr/bin/env node
import { handleReadmeFlag } from "@app/utils/readme";
import chalk from "chalk";
import { Command } from "commander";

// Handle --readme flag early (before Commander parses)
handleReadmeFlag(import.meta.url);

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { checkLLMModel, downloadLLMModel } from "@nanocollective/get-md";
import { type EngineName, getEngine, listEngines } from "./engines/index.js";
import {
    compactCodeBlocks,
    fetchText,
    handleFetchJina,
    handleFetchWebMarkdown,
    handleFetchWebRaw,
} from "./handlers.js";
import { limitToTokens } from "./utils/tokens.js";
import { buildJinaUrl, ensureHttpUrl } from "./utils/urls.js";

const log = {
    info: (msg: string) => console.log(chalk.blue("ℹ️ ") + msg),
    ok: (msg: string) => console.log(chalk.green("✔ ") + msg),
    warn: (msg: string) => console.log(chalk.yellow("⚠ ") + msg),
    err: (msg: string, e?: unknown) => console.error(chalk.red("❌ ") + msg + (e ? `: ${String(e)}` : "")),
};

// CLI options interface
interface CliOptions {
    url: string;
    mode: string;
    depth: string;
    engine: string;
    out?: string;
    tokens?: string;
    saveTokens: boolean;
    headers?: string;
}

// CLI
async function runCli(opts: CliOptions): Promise<void> {
    const url = ensureHttpUrl(String(opts.url));
    const mode = opts.mode;
    const depth = (opts.depth || "basic") as "basic" | "advanced";
    const engineName = (opts.engine || "turndown") as EngineName;
    const out = opts.out;
    const maxTokens = opts.tokens ? Number(opts.tokens) : undefined;
    const saveTokens = opts.saveTokens;

    try {
        if (mode === "raw") {
            log.info(`Fetching raw HTML: ${chalk.cyan(url)}`);
            const headers = opts.headers ? JSON.parse(String(opts.headers)) : undefined;
            let html = await fetchText(url, headers);
            if (saveTokens) {
                html = html.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");
            }
            const limited = limitToTokens(html, maxTokens);
            if (out) {
                await Bun.write(out, limited.text);
                log.ok(`Wrote HTML to ${out}`);
            } else {
                process.stdout.write(`${limited.text}\n`);
            }
            return;
        }

        if (mode === "jina") {
            const jUrl = buildJinaUrl(url);
            log.info(`Fetching Jina Reader MD: ${chalk.cyan(jUrl)}`);
            let md = await fetchText(jUrl);
            if (saveTokens) {
                md = compactCodeBlocks(md);
            }
            const limited = limitToTokens(md, maxTokens);
            if (out) {
                await Bun.write(out, limited.text);
                log.ok(`Wrote Jina MD to ${out}`);
            } else {
                process.stdout.write(`${limited.text}\n`);
            }
            return;
        }

        if (mode === "markdown") {
            log.info(`Fetching HTML and extracting with engine "${engineName}": ${chalk.cyan(url)}`);
            const html = await fetchText(url);

            // Use the new engine system
            const engine = getEngine(engineName);
            const result = await engine.convert(html, {
                baseUrl: url,
                depth,
            });

            let md = result.markdown;
            if (saveTokens) {
                md = compactCodeBlocks(md);
            }
            const limited = limitToTokens(md, maxTokens);

            if (out) {
                await Bun.write(out, limited.text);
                log.ok(
                    `Wrote extracted MD to ${out} (engine: ${engineName}, time: ${Math.round(result.metrics.conversionTimeMs)}ms)`,
                );
            } else {
                process.stdout.write(`${limited.text}\n`);
            }
            return;
        }

        log.err(`Unknown mode: ${mode} (expected raw|markdown|jina)`);
        process.exit(1);
    } catch (e) {
        log.err("Failed", e);
        process.exit(1);
    }
}

// MCP server
const server = new Server(
    {
        name: "mcp-web-reader",
        version: "0.2.0",
    },
    { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "FetchWebRaw",
                description: "Fetch raw HTML of a URL (depth, save_tokens, tokens)",
                inputSchema: {
                    type: "object",
                    properties: {
                        url: { type: "string" },
                        headers: { type: "object", description: "Optional headers" },
                        depth: { type: "string", enum: ["basic", "advanced"], description: "Extraction depth" },
                        save_tokens: {
                            type: "number",
                            enum: [0, 1],
                            description: "Compact code blocks to save tokens",
                        },
                        tokens: { type: "number", description: "Max tokens to return" },
                    },
                    required: ["url"],
                },
            },
            {
                name: "FetchJina",
                description:
                    "Fetch Markdown via Jina Reader (https://r.jina.ai/http://...) (depth, save_tokens, tokens)",
                inputSchema: {
                    type: "object",
                    properties: {
                        url: { type: "string" },
                        depth: {
                            type: "string",
                            enum: ["basic", "advanced"],
                            description: "Extraction depth (info only)",
                        },
                        save_tokens: {
                            type: "number",
                            enum: [0, 1],
                            description: "Compact code blocks to save tokens",
                        },
                        tokens: { type: "number", description: "Max tokens to return" },
                    },
                    required: ["url"],
                },
            },
            {
                name: "FetchWebMarkdown",
                description:
                    "Extract Markdown locally using pluggable engines (turndown, mdream, readerlm). Supports depth, engine selection, save_tokens, and token limits.",
                inputSchema: {
                    type: "object",
                    properties: {
                        url: { type: "string", description: "URL to fetch and convert" },
                        engine: {
                            type: "string",
                            enum: ["turndown", "mdream", "readerlm"],
                            description:
                                "Conversion engine: turndown (default, GFM support), mdream (fast, LLM-optimized), readerlm (AI-powered placeholder)",
                        },
                        depth: {
                            type: "string",
                            enum: ["basic", "advanced"],
                            description: "Extraction depth (basic=title only, advanced=YAML frontmatter)",
                        },
                        save_tokens: {
                            type: "number",
                            enum: [0, 1],
                            description: "Compact code blocks to save tokens",
                        },
                        tokens: { type: "number", description: "Max tokens to return" },
                    },
                    required: ["url"],
                },
            },
        ],
    };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments || {}) as Record<string, unknown>;

    try {
        if (name === "FetchWebRaw") {
            return await handleFetchWebRaw(args);
        }

        if (name === "FetchJina") {
            return await handleFetchJina(args);
        }

        if (name === "FetchWebMarkdown") {
            return await handleFetchWebMarkdown(args);
        }

        return Object.create(null);
    } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        return {
            isError: true,
            content: [{ type: "text", text: `Error: ${message}` }],
        };
    }
});

async function main(): Promise<void> {
    const engineChoices = listEngines()
        .map((e) => e.name)
        .join("|");

    const program = new Command()
        .name("mcp-web-reader")
        .description("Web content reader (MCP + CLI) with pluggable markdown engines")
        .argument("[url]", "URL to fetch (or use --url)")
        .option("-u, --url <url>", "Source URL")
        .option("-m, --mode <mode>", "raw | markdown | jina", "markdown")
        .option("-e, --engine <engine>", `Markdown engine: ${engineChoices}`, "turndown")
        .option("-d, --depth <depth>", "Extraction depth: basic | advanced", "basic")
        .option("-T, --tokens <n>", "Max AI tokens to return")
        .option("-s, --save-tokens", "Compact code blocks and whitespace")
        .option("-o, --out <path>", "Output file path")
        .option("--headers <json>", "Additional request headers as JSON")
        .option("--server", "Start as MCP server instead of CLI")
        .option("--list-engines", "List available markdown engines")
        .option("--model-info", "Show ReaderLM model status")
        .option("--download-model", "Download ReaderLM model (~1GB)")
        .parse();

    const opts = program.opts();
    const args = program.args;

    if (opts.listEngines) {
        console.log("Available engines:");
        for (const engine of listEngines()) {
            console.log(`  ${chalk.cyan(engine.name)}: ${engine.description}`);
        }
        return;
    }

    if (opts.modelInfo) {
        log.info("Checking ReaderLM model status...");
        const status = await checkLLMModel();
        if (status.available) {
            log.ok(`Model available: ${status.path}`);
            console.log(`  Size: ${status.sizeFormatted}`);
        } else {
            log.warn("Model not downloaded");
            console.log("  Run with --download-model to download (~1GB)");
        }
        return;
    }

    if (opts.downloadModel) {
        const status = await checkLLMModel();
        if (status.available) {
            log.ok(`Model already downloaded: ${status.path}`);
        } else {
            log.info("Downloading ReaderLM-v2 (~1GB)");
            console.log(`  Model: ${chalk.cyan("https://huggingface.co/jinaai/ReaderLM-v2")}`);
            console.log(`  HTML-to-Markdown conversion optimized for LLMs (512K tokens, 29 languages)`);
            let lastUpdate = 0;
            await downloadLLMModel({
                onProgress: (downloaded, total, pct) => {
                    const now = Date.now();
                    if (now - lastUpdate < 1000 && pct < 100) {
                        return; // Throttle to 1s
                    }
                    lastUpdate = now;
                    process.stdout.clearLine?.(0);
                    process.stdout.cursorTo?.(0);
                    process.stdout.write(
                        `  Progress: ${pct.toFixed(1)}% (${(downloaded / 1e6).toFixed(0)}MB / ${(total / 1e6).toFixed(0)}MB)`,
                    );
                },
            });
            console.log("");
            log.ok("Model downloaded successfully!");
        }
        // If no URL provided, just exit after download
        const url = args[0] || opts.url;
        if (!url) {
            return;
        }
        // Otherwise continue to convert with the URL
    }

    if (opts.server) {
        const transport = new StdioServerTransport();
        await server.connect(transport);
        console.error("mcp-web-reader server running (v0.2.0)");
        return;
    }

    // URL from positional arg or --url option
    const url = args[0] || opts.url;
    if (!url) {
        log.err("URL is required (positional or --url)");
        process.exit(1);
    }

    await runCli({
        url,
        mode: opts.mode,
        engine: opts.engine || "turndown",
        depth: opts.depth || "basic",
        out: opts.out,
        tokens: opts.tokens,
        saveTokens: opts.saveTokens || false,
        headers: opts.headers,
    });
}

main().catch((e) => {
    console.error("Fatal error:", e);
    process.exit(1);
});
