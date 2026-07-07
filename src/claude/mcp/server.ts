import { logger } from "@app/logger";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { handleQuestionAnswer, QUESTION_ANSWER_INPUT_SCHEMA, type QuestionAnswerArgs } from "./tools/question-answer";

const log = logger.child({ component: "claude:mcp" });

const QUESTION_ANSWER_DESCRIPTION =
    "Preserve an important user question together with your COMPLETE answer (markdown ok) to the local " +
    "question store for later review. Use when the user directly asks a question worth keeping — rationale " +
    '("why did you choose X over Y"), design/architecture decisions, "how does Y work", tradeoff explanations ' +
    "— or right after you answer a substantive question/directive/status-nudge the user interjected " +
    'mid-session. Not for routine task instructions you simply execute or pure acknowledgements ("ok", "thanks").';

const SERVER_INSTRUCTIONS =
    "Genesis Tools — question/answer capture server.\n\n" +
    "WHEN TO USE THE question_answer TOOL:\n" +
    '- The user directly asks a question important enough to preserve for later review: rationale ("why did ' +
    'you choose X over Y"), design/architecture decisions, "how does Y work", tradeoff explanations.\n' +
    "- Immediately AFTER you answer a substantive question, directive, or status-nudge the user interjected " +
    'mid-session (e.g. "what\'s left from the plan?", "pushed yet?", "did the tests pass?") — so the answer ' +
    "isn't lost in scrollback.\n" +
    "- Whenever the user invokes the /question skill directly.\n\n" +
    "Call it with the user's question, your COMPLETE answer (markdown ok), a tag (question | directive | " +
    "action), and optional refs. It persists to the local question store, browsable later with " +
    "`tools question log` / `tools question tail`.\n\n" +
    "DO NOT use for: routine task instructions you simply execute, pure acknowledgements " +
    '("ok", "thanks", "continue"), or trivial lookups not worth preserving.';

interface ToolEntry {
    description: string;
    inputSchema: Record<string, unknown>;
    handler: (args: Record<string, unknown>) => Promise<string>; // returns the text content
}

function buildToolRegistry(): Record<string, ToolEntry> {
    return {
        question_answer: {
            description: QUESTION_ANSWER_DESCRIPTION,
            inputSchema: QUESTION_ANSWER_INPUT_SCHEMA as unknown as Record<string, unknown>,
            handler: async (args) => {
                const r = await handleQuestionAnswer(args as unknown as QuestionAnswerArgs);
                return r.summary;
            },
        },
    };
}

export async function startMcpServer(): Promise<void> {
    const registry = buildToolRegistry();
    const server = new Server(
        { name: "genesis-tools", version: "1.0.0" },
        { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: Object.entries(registry).map(([name, t]) => ({
            name,
            description: t.description,
            inputSchema: t.inputSchema,
        })),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const entry = registry[request.params.name];
        if (!entry) {
            return { content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }], isError: true };
        }

        try {
            const text = await entry.handler((request.params.arguments ?? {}) as Record<string, unknown>);
            return { content: [{ type: "text", text }] };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log.warn({ err, tool: request.params.name }, "mcp tool handler failed");
            return { content: [{ type: "text", text: `${request.params.name} failed: ${message}` }], isError: true };
        }
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);
    log.info("genesis-tools MCP server started (stdio)");
}
