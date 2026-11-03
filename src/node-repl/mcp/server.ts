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
import { ReplEngine, resultMessage } from "../lib/engine";
import { createToolsets, parseToolsetList } from "../lib/toolsets";

// stdio MCP server: stdout carries JSON-RPC frames, so every diagnostic goes through the
// logger (file plus the gated stderr stream), never console.log.
const log = logger.scoped("node-repl").log;

const JS_DESCRIPTION =
    "Execute JavaScript or TypeScript in a persistent REPL with top-level await. Top-level let, const, class and function bindings survive across calls and can be redeclared, until js_reset. Use nodeRepl.write(value) for output, and await show(image | path | Buffer) to return an image to the model; help() lists the loaded toolsets and help(name) prints one's API. nodeRepl.cwd, nodeRepl.homeDir and nodeRepl.tmpDir are available. Use dynamic import(); node: builtins, absolute paths and the server's own dependencies resolve, plus any directory added with js_add_node_module_dir. The default timeout is 30000 ms; a turn that overruns is killed with every binding.";

/** The `js` description: the fixed text, then one line per preloaded toolset. */
export function jsDescription(toolsetLines: readonly string[]): string {
    if (toolsetLines.length === 0) {
        return JS_DESCRIPTION;
    }

    const lines = toolsetLines.map((line) => `- ${line}`).join("\n");
    return `${JS_DESCRIPTION} Preloaded globals, built once per worker (help(name) for the full API):\n${lines}`;
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
                    description:
                        "Kill the REPL worker and start a fresh one: every binding is gone, the preloaded toolsets are disposed and preloaded again, registered module directories stay.",
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
                const code = typeof args.code === "string" ? args.code : "";

                if (!code) {
                    return { content: [{ type: "text", text: "code is required" }], isError: true };
                }

                const timeout =
                    typeof args.timeout_ms === "number" && args.timeout_ms > 0
                        ? args.timeout_ms
                        : engine.defaultTimeoutMs;
                const result = await engine.run(code, timeout);
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
            case "js_reset":
                await engine.reset();
                return { content: [{ type: "text", text: "REPL reset; bindings cleared" }] };
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

export async function startMcpServer(options: { toolsets?: readonly string[]; name?: string } = {}): Promise<void> {
    const toolsets = parseToolsetList(options.toolsets ?? []);
    const engine = new ReplEngine({ toolsets });
    const toolsetLines = (await createToolsets(toolsets)).map((toolset) => toolset.oneLine());
    await serveStdio({
        name: options.name ?? "node-repl",
        server: createServer(engine, { toolsetLines }),
        transport: new StdioServerTransport(),
        shutdown: () => engine.shutdown(),
        onExit: () => engine.dispose(),
    });
}
