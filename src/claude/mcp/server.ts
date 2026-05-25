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

export async function startMcpServer(): Promise<void> {
    const server = new Server(
        { name: "genesis-tools", version: "1.0.0" },
        { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
    );

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
