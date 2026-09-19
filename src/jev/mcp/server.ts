import { createEvaluator, type Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import {
    type CallToolResult,
    type ListToolsResult,
    ProtocolError,
    ProtocolErrorCode,
    Server,
    type Tool,
} from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { JevMcpRegistry } from "./registry";
import { handleJevCompact, jevCompactInputSchema, jevCompactTool } from "./tools/compact";
import { type JevRouteDeps, registerJevRouteTool } from "./tools/route";
import { handleJevVerify, handleJevVerifyTemplates, jevVerifyTemplatesTool, jevVerifyTool } from "./tools/verify";

const { log } = logger.scoped("jev-route");
const prof = profiler.scope("jev-route");

/**
 * Register every Jev MCP tool that exists today.
 *
 * `jev_compact` and `jev_verify` arrive with their own packages; they call `registry.add(...)`
 * from here, so the transport wiring below never changes.
 */
const jevVerifyInput = z
    .object({
        claims: z.string().min(1).describe("JSON array of {id,text}, or one claim per line"),
        against: z.string().min(1).describe("The document text to judge the claims against"),
        purpose: z.string().optional().describe("Comma-separated purpose template ids"),
        task: z.string().optional().describe("Task description for the relevance template"),
        custom: z.string().optional().describe("JSON array of extra templates"),
        uri: z.string().optional().describe("Label for the document in the result"),
    })
    .strict();

/**
 * One evaluator per server process. The evaluator resolves the credential once and routes the
 * provider per call itself (`createEvaluatorWithProviderFactory`), so building a new one on every
 * MCP request only repeated the vault read. It is created on the first paid call, never at startup,
 * so listing tools costs nothing and a host without a Jev key still gets `jev_verify_templates`.
 */
function sharedEvaluator(deps: JevRouteDeps): Evaluator {
    let shared: Promise<Evaluator> | undefined;
    return (call) =>
        prof.measureAsync("mcp-evaluate", async () => {
            if (deps.evaluate) {
                return deps.evaluate(call);
            }

            shared ??= createEvaluator({ provider: deps.provider ?? "vercel" });
            return (await shared)(call);
        });
}

export function registerJevMcpTools(registry: JevMcpRegistry, deps: JevRouteDeps = {}): JevMcpRegistry {
    const evaluate = sharedEvaluator(deps);
    registerJevRouteTool(registry, { ...deps, evaluate });
    registry.add({
        name: jevCompactTool.name,
        description: jevCompactTool.description,
        inputSchema: jevCompactInputSchema,
        readOnly: true,
        run: (raw, context) => handleJevCompact(jevCompactInputSchema.parse(raw), context.signal, evaluate),
    });
    registry.add({
        name: jevVerifyTool.name,
        description: jevVerifyTool.description,
        inputSchema: jevVerifyInput,
        readOnly: true,
        run: async (raw, context) => handleJevVerify(jevVerifyInput.parse(raw), { evaluate, signal: context.signal }),
    });
    registry.add({
        name: jevVerifyTemplatesTool.name,
        description: jevVerifyTemplatesTool.description,
        inputSchema: z.object({}).strict(),
        readOnly: true,
        run: async () => handleJevVerifyTemplates(),
    });
    return registry;
}

export function createJevMcpServer(options: { registry?: JevMcpRegistry; deps?: JevRouteDeps } = {}): Server {
    const registry = options.registry ?? registerJevMcpTools(new JevMcpRegistry(), options.deps ?? {});
    const server = new Server({ name: "genesis-jev", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(
        "tools/list",
        async (): Promise<ListToolsResult> => ({
            tools: registry.list().map((tool) => ({
                name: tool.name,
                description: tool.description,
                inputSchema: z.toJSONSchema(tool.inputSchema, { io: "input" }) as Tool["inputSchema"],
                annotations: { readOnlyHint: tool.readOnly, destructiveHint: false, openWorldHint: false },
            })),
        })
    );
    server.setRequestHandler("tools/call", async (request, context): Promise<CallToolResult> => {
        const tool = registry.get(request.params.name);
        if (!tool) {
            throw new ProtocolError(ProtocolErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
        }

        try {
            const result = await tool.run(request.params.arguments ?? {}, { signal: context.mcpReq.signal });
            return { content: [{ type: "text", text: SafeJSON.stringify(result) }] };
        } catch (error) {
            log.warn({ error, tool: tool.name }, "Jev MCP tool failed");
            return {
                content: [
                    {
                        type: "text",
                        text: SafeJSON.stringify({
                            error: error instanceof Error ? error.message : "Jev MCP request failed.",
                        }),
                    },
                ],
                isError: true,
            };
        }
    });
    log.debug({ tools: registry.list().map((tool) => tool.name) }, "Jev MCP server created");
    return server;
}

export async function startJevMcpServer(options: { deps?: JevRouteDeps } = {}): Promise<void> {
    const server = createJevMcpServer(options);
    const transport = new StdioServerTransport();
    const stop = () => {
        void server.close().finally(() => process.exit(0));
    };
    process.stdin.once("end", stop);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    await server.connect(transport);
    logger.info("Jev MCP server is listening on stdio");
}
