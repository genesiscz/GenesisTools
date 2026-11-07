import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { serveStdio, TURN_ENDED_TOOL } from "@genesiscz/utils/mcp/stdio";
import {
    type CallToolResult,
    type ListToolsResult,
    ProtocolError,
    ProtocolErrorCode,
    Server,
} from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { mcpTimeoutHint, ReplEngine, resultMessage } from "../lib/engine";
import { createToolsets, parseToolsetList } from "../lib/toolsets";

// stdio MCP server: stdout carries JSON-RPC frames, so every diagnostic goes through the
// logger (file plus the gated stderr stream), never console.log.
const log = logger.scoped("node-repl").log;

const JS_DESCRIPTION =
    "Execute JavaScript or TypeScript in a persistent REPL with top-level await. Top-level let, const, class and function bindings survive across calls and can be redeclared, until js_reset. Use nodeRepl.write(value) for output, and await show(image | path | Buffer) to return an image to the model; help() lists the loaded toolsets and help(name) prints one's API. nodeRepl.cwd, nodeRepl.homeDir and nodeRepl.tmpDir are available. Use dynamic import(); node: builtins, absolute paths and the server's own dependencies resolve, plus any directory added with js_add_node_module_dir. The default timeout is 30000 ms; a turn that overruns is killed with every binding. A turn's text longer than the server's --max-output (20000 characters by default) is cut, with a note naming the file that holds all of it.";

const JS_ARGUMENTS = ["code", "timeout_ms", "title"];
const TITLE_MAX_CHARS = 80;

/**
 * The `js` arguments as its input schema declares them, or why they are refused. A host may skip the schema check, and
 * `timeout_ms: -5`, `"abc"` and an unknown key all ran with the defaults (NR16).
 */
export function parseJsArguments(
    args: Record<string, unknown>
): { code: string; timeoutMs?: number; title?: string } | { error: string } {
    const unknown = Object.keys(args).filter((key) => !JS_ARGUMENTS.includes(key));

    if (unknown.length > 0) {
        return { error: `js takes code, timeout_ms and title; unknown: ${unknown.join(", ")}` };
    }

    if (typeof args.code !== "string" || args.code === "") {
        return { error: "code is required" };
    }

    const timeout = args.timeout_ms;

    if (timeout !== undefined && (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 1)) {
        return { error: `timeout_ms is a whole number of milliseconds, 1 or more; got ${SafeJSON.stringify(timeout)}` };
    }

    if (args.title !== undefined && typeof args.title !== "string") {
        return { error: `title is a string; got ${SafeJSON.stringify(args.title)}` };
    }

    return {
        code: args.code,
        ...(timeout === undefined ? {} : { timeoutMs: timeout }),
        ...(args.title === undefined ? {} : { title: args.title.slice(0, TITLE_MAX_CHARS) }),
    };
}

/** The toolsets whose calls can start a recording that the engine owns and finishes on a reset. */
const RECORDING_TOOLSETS = ["recorder", "movies"];

/** The `js_reset` description; the recording budgets only when a toolset that records is loaded (NR29). */
export function jsResetDescription(toolsets: readonly string[]): string {
    const recordings = toolsets.some((id) => RECORDING_TOOLSETS.includes(id))
        ? " Owned recordings are stopped and finalized: pending recording startups may take up to 120 seconds by default, followed by up to 10 minutes for finalization. Toolsets then get up to 10 seconds to dispose before the worker is killed."
        : toolsets.length > 0
          ? " Toolsets then get up to 10 seconds to dispose before the worker is killed."
          : "";
    return `Reset the REPL and cancel queued turns; a running turn answers "cancelled by js_reset".${recordings} Every binding is gone; registered module directories stay.`;
}

/** The `js` description: the fixed text, then one line per preloaded toolset. */
export function jsDescription(toolsetLines: readonly string[]): string {
    if (toolsetLines.length === 0) {
        return JS_DESCRIPTION;
    }

    const lines = toolsetLines.map((line) => `- ${line}`).join("\n");
    return `${JS_DESCRIPTION} Preloaded globals, built once per worker (search(query) to find methods; describe(name) for full method docs; help(name) for a toolset; a method marked [read] changes nothing and reaches no one, "· user" or "· paid" marks one that reaches the user or costs money):\n${lines}`;
}

/**
 * Same four tool names as Codex's node_repl, so a prompt or skill that already says "use js"
 * keeps working against this server. `turn_ended` is the host-bookkeeping no-op it is there too.
 */
export function createServer(engine: ReplEngine, options: { toolsetLines?: readonly string[] } = {}): Server {
    const description = jsDescription(options.toolsetLines ?? []);
    const server = new Server({ name: "genesis-node-repl", version: "1.0.0" }, { capabilities: { tools: {} } });

    server.setRequestHandler(
        "tools/list",
        async (): Promise<ListToolsResult> => ({
            tools: [
                {
                    name: "js",
                    description,
                    inputSchema: {
                        type: "object",
                        properties: {
                            code: {
                                type: "string",
                                description: "JavaScript or TypeScript to run, top-level await allowed.",
                            },
                            timeout_ms: {
                                type: "integer",
                                minimum: 1,
                                description: "Wall-clock budget in milliseconds. Default 30000.",
                            },
                            title: { type: "string", maxLength: 80, description: "Short label for logs and history." },
                        },
                        required: ["code"],
                        additionalProperties: false,
                    },
                    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
                },
                {
                    name: "js_add_node_module_dir",
                    description:
                        "Add an absolute directory whose node_modules becomes resolvable from import() inside the REPL. Survives js_reset.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            path: {
                                type: "string",
                                minLength: 1,
                                description: "Absolute directory containing node_modules.",
                            },
                        },
                        required: ["path"],
                        additionalProperties: false,
                    },
                },
                {
                    name: "js_reset",
                    description: jsResetDescription(engine.toolsets),
                    inputSchema: { type: "object", properties: {}, additionalProperties: false },
                },
                TURN_ENDED_TOOL,
            ],
        })
    );

    server.setRequestHandler("tools/call", async (request): Promise<CallToolResult> => {
        const name = request.params.name;
        const args = (request.params.arguments ?? {}) as Record<string, unknown>;
        log.debug({ tool: name }, "node-repl tool call");

        switch (name) {
            case "js": {
                const parsed = parseJsArguments(args);

                if ("error" in parsed) {
                    return { content: [{ type: "text", text: parsed.error }], isError: true };
                }

                const result = await engine.run(parsed.code, parsed.timeoutMs ?? engine.defaultTimeoutMs);
                log.info(
                    { title: parsed.title, durationMs: result.durationMs, ok: result.ok, chars: result.text.length },
                    "node-repl turn"
                );
                const content: CallToolResult["content"] = [];

                if (result.text) {
                    content.push({ type: "text", text: result.text });
                }

                for (const image of result.images) {
                    content.push({ type: "image", data: image.data, mimeType: image.mimeType });
                    content.push({ type: "text", text: `image written to ${image.path}` });
                }

                if (!result.ok) {
                    content.push({ type: "text", text: result.stack ?? result.error ?? "unknown error" });
                }

                if (content.length === 0) {
                    content.push({ type: "text", text: "" });
                }

                return { content, isError: !result.ok, _meta: { "genesis/durationMs": result.durationMs } };
            }
            case "js_add_node_module_dir": {
                const path = typeof args.path === "string" ? args.path : "";

                if (!path.startsWith("/")) {
                    return { content: [{ type: "text", text: "path must be absolute" }], isError: true };
                }

                const result = await engine.addModuleDir(path);
                return { content: [{ type: "text", text: resultMessage(result) }], isError: !result.ok };
            }
            case "js_reset": {
                const notes = await engine.reset();
                return { content: [{ type: "text", text: ["REPL reset; bindings cleared", ...notes].join("\n") }] };
            }
            case "turn_ended":
                return { content: [] };
            default:
                // A tool the server never advertised is a lookup failure, so it belongs in the
                // JSON-RPC error channel, never in an isError result. Asserted for every in-repo
                // stdio server by src/mcp-manager/lib/doctor/unknown-tool.contract.test.ts.
                throw new ProtocolError(ProtocolErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }
    });

    return server;
}

export async function startMcpServer(
    options: { toolsets?: readonly string[]; name?: string; maxOutputChars?: number } = {}
): Promise<void> {
    const toolsets = parseToolsetList(options.toolsets ?? []);
    const engine = new ReplEngine({ toolsets, maxOutputChars: options.maxOutputChars, timeoutHint: mcpTimeoutHint });
    const toolsetLines = (await createToolsets(toolsets)).map((toolset) => toolset.oneLine());
    await serveStdio({
        name: options.name ?? "node-repl",
        server: createServer(engine, { toolsetLines }),
        transport: new StdioServerTransport(),
        shutdown: () => engine.shutdown(),
        shutdownTimeoutMs: engine.shutdownTimeoutMs,
        onExit: () => engine.dispose(),
    });
}
