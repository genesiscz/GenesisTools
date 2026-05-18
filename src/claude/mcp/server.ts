import logger from "@app/logger";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { handleQuestionAnswer, QUESTION_ANSWER_INPUT_SCHEMA, type QuestionAnswerArgs } from "./tools/question-answer";

const log = logger.child({ component: "claude:mcp" });

const QUESTION_ANSWER_DESCRIPTION =
    "After answering a substantive user question/directive mid-session, call this with your COMPLETE answer " +
    "(markdown ok) so it is captured for later review.";

export async function startMcpServer(): Promise<void> {
    const server = new Server({ name: "genesis-tools", version: "1.0.0" }, { capabilities: { tools: {} } });

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
            {
                name: "question_answer",
                description: QUESTION_ANSWER_DESCRIPTION,
                inputSchema: QUESTION_ANSWER_INPUT_SCHEMA,
            },
        ],
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        if (request.params.name !== "question_answer") {
            return { content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }], isError: true };
        }

        try {
            const args = (request.params.arguments ?? {}) as unknown as QuestionAnswerArgs;
            const r = await handleQuestionAnswer(args);
            return { content: [{ type: "text", text: r.summary }] };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log.warn({ err }, "question_answer handler failed");
            return { content: [{ type: "text", text: `Failed to log Q→A: ${message}` }], isError: true };
        }
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);
    log.info("genesis-tools MCP server started (stdio)");
}
