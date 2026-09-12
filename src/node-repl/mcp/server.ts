import { logger } from "@genesiscz/utils/logger";
import { type CallToolResult, type ListToolsResult, Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { ReplEngine } from "../lib/engine";

// stdio MCP server: stdout carries JSON-RPC frames, so every diagnostic goes through the
// logger (file plus the gated stderr stream), never console.log.
const log = logger.scoped("node-repl").log;

/**
 * Same four tool names as Codex's node_repl, so a prompt or skill that already says "use js"
 * keeps working against this server. `turn_ended` is the host-bookkeeping no-op it is there too.
 */
export function createServer(engine: ReplEngine): Server {
    const server = new Server({ name: "genesis-node-repl", version: "1.0.0" }, { capabilities: { tools: {} } });

    server.setRequestHandler(
        "tools/list",
        async (): Promise<ListToolsResult> => ({
            tools: [
                {
                    name: "js",
                    description:
                        "Execute JavaScript or TypeScript in a persistent REPL with top-level await. Top-level let, const, class and function bindings survive across calls and can be redeclared, until js_reset. Use nodeRepl.write(value) for output and await nodeRepl.emitImage({ bytes, mimeType }) for images; nodeRepl.cwd, nodeRepl.homeDir and nodeRepl.tmpDir are available. Use dynamic import(); node: builtins, absolute paths and the server's own dependencies resolve, plus any directory added with js_add_node_module_dir. The default timeout is 30000 ms; a turn that overruns is killed with every binding.",
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
                        "Kill the REPL worker and start a fresh one: every binding is gone, registered module directories stay.",
                    inputSchema: { type: "object", properties: {}, additionalProperties: false },
                },
                {
                    name: "turn_ended",
                    description:
                        "Notify the REPL that an agent turn ended. A no-op kept for compatibility with hosts that send it.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            hook_event_name: { type: "string" },
                            session_id: { type: "string" },
                            turn_id: { type: "string" },
                        },
                        additionalProperties: true,
                    },
                    annotations: { idempotentHint: true },
                },
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
                return { content: [{ type: "text", text: result.text }], isError: !result.ok };
            }
            case "js_reset":
                engine.reset();
                return { content: [{ type: "text", text: "REPL reset; bindings cleared" }] };
            case "turn_ended":
                return { content: [] };
            default:
                return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
        }
    });

    return server;
}

export async function startMcpServer(): Promise<void> {
    const engine = new ReplEngine();
    const server = createServer(engine);
    const transport = new StdioServerTransport();
    // The worker child would keep this process alive after the host closes stdin, and the
    // stdio transport does not turn an ended stdin into onclose, so both are wired.
    const stop = (reason: string): void => {
        log.info({ reason }, "node-repl MCP server stopping");
        engine.dispose();
        process.exit(0);
    };
    server.onclose = () => stop("transport closed");
    process.stdin.once("end", () => stop("stdin ended"));
    await server.connect(transport);
    log.info("node-repl MCP server listening on stdio");
    process.on("exit", () => engine.dispose());
}
