import { logger } from "@genesiscz/utils/logger";
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
import { DEPTHS, ENGINE_NAMES, unknownEngineMessage } from "../lib/convert";
import { type ReadResult, readPage } from "../lib/read";

const SERVER_NAME = "mcp-web-reader";
const SERVER_VERSION = "0.3.0";

const url = z.string().min(1).describe("Page URL; a bare host such as example.com gets https://");
const headers = z.record(z.string(), z.string()).optional().describe("Extra request headers sent to the page");
const tokens = z.number().int().positive().optional().describe("Return at most this many tokens; the rest is cut");
const saveTokens = z
    .union([z.boolean(), z.literal(0), z.literal(1)])
    .optional()
    .describe("Compact whitespace (raw HTML) or code blocks (markdown) to save tokens");

const rawInput = z.object({ url, headers, save_tokens: saveTokens, tokens });
const jinaInput = z.object({ url, save_tokens: saveTokens, tokens });
const markdownInput = z.object({
    url,
    headers,
    engine: z
        .enum(ENGINE_NAMES, { error: (issue) => unknownEngineMessage(String(issue.input)) })
        .optional()
        .describe("Conversion engine (default turndown)"),
    depth: z
        .enum(DEPTHS)
        .optional()
        .describe("basic = the markdown only, advanced = YAML front matter with title, URL, author and date first"),
    save_tokens: saveTokens,
    tokens,
});

interface WebReaderTool {
    name: string;
    description: string;
    inputSchema: z.ZodType;
    run(args: unknown, signal: AbortSignal): Promise<ReadResult>;
}

const TOOLS: WebReaderTool[] = [
    {
        name: "FetchWebMarkdown",
        description:
            "Fetch a page and return its main content as Markdown, converted locally: navigation, sidebars, " +
            "footers, ads and cookie banners are dropped, links and images become absolute.",
        inputSchema: markdownInput,
        run: (args, signal) => {
            const input = markdownInput.parse(args);
            return readPage({
                url: input.url,
                mode: "markdown",
                engine: input.engine,
                depth: input.depth,
                headers: input.headers,
                maxTokens: input.tokens,
                saveTokens: Boolean(input.save_tokens),
                signal,
            });
        },
    },
    {
        name: "FetchWebRaw",
        description: "Fetch the raw HTML of a page.",
        inputSchema: rawInput,
        run: (args, signal) => {
            const input = rawInput.parse(args);
            return readPage({
                url: input.url,
                mode: "raw",
                headers: input.headers,
                maxTokens: input.tokens,
                saveTokens: Boolean(input.save_tokens),
                signal,
            });
        },
    },
    {
        name: "FetchJina",
        description:
            "Fetch a page as Markdown rendered by the Jina Reader service (https://r.jina.ai/<url>). The page " +
            "URL is sent to Jina; use it for pages that need JavaScript to render.",
        inputSchema: jinaInput,
        run: (args, signal) => {
            const input = jinaInput.parse(args);
            return readPage({
                url: input.url,
                mode: "jina",
                maxTokens: input.tokens,
                saveTokens: Boolean(input.save_tokens),
                signal,
            });
        },
    },
];

function toCallToolResult(result: ReadResult): CallToolResult {
    return {
        content: [{ type: "text", text: result.text }],
        _meta: {
            tokens: result.tokens,
            truncated: result.truncated,
            source: result.source,
            ...(result.conversion ?? {}),
        },
    };
}

function errorMessage(error: unknown): string {
    if (error instanceof z.ZodError) {
        return z.prettifyError(error);
    }

    return error instanceof Error ? error.message : String(error);
}

export function createWebReaderServer(): Server {
    const server = new Server({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} } });

    server.setRequestHandler(
        "tools/list",
        async (): Promise<ListToolsResult> => ({
            tools: TOOLS.map((tool) => ({
                name: tool.name,
                description: tool.description,
                inputSchema: z.toJSONSchema(tool.inputSchema, { io: "input" }) as Tool["inputSchema"],
                annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
            })),
        })
    );

    server.setRequestHandler("tools/call", async (request, context): Promise<CallToolResult> => {
        const tool = TOOLS.find((candidate) => candidate.name === request.params.name);
        if (!tool) {
            throw new ProtocolError(ProtocolErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
        }

        try {
            return toCallToolResult(await tool.run(request.params.arguments ?? {}, context.mcpReq.signal));
        } catch (error) {
            logger.warn({ error, tool: tool.name }, "mcp-web-reader tool call failed");
            return { isError: true, content: [{ type: "text", text: `Error: ${errorMessage(error)}` }] };
        }
    });

    return server;
}

export async function startMcpServer(): Promise<void> {
    await createWebReaderServer().connect(new StdioServerTransport());
    logger.debug({ version: SERVER_VERSION, tools: TOOLS.map((tool) => tool.name) }, "mcp-web-reader server running");
}
