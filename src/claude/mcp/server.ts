import { logger } from "@app/logger";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
    handleGetAnnotation,
    handleGetCapsule,
    handleGetSet,
    handleListBoards,
    handleListSets,
    handleListWork,
} from "./tools/boards/read-tools";
import {
    ATTACH_AFTER_SCHEMA,
    GET_ANNOTATION_SCHEMA,
    GET_CAPSULE_SCHEMA,
    GET_SET_SCHEMA,
    HIGHLIGHT_SCHEMA,
    LIST_BOARDS_SCHEMA,
    LIST_SETS_SCHEMA,
    LIST_WORK_SCHEMA,
    REPLY_SCHEMA,
    SET_STATUS_SCHEMA,
    WAIT_FOR_WORK_SCHEMA,
} from "./tools/boards/schemas";
import { handleWaitForWork } from "./tools/boards/wait-for-work";
import { handleAttachAfter, handleHighlight, handleReply, handleSetStatus } from "./tools/boards/work-tools";
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
    '("ok", "thanks", "continue"), or trivial lookups not worth preserving.\n\n' +
    "BOARDS (dev-dashboard annotation boards):\n" +
    "- The user annotates screenshots on /boards/<slug>; each dispatched annotation is a work item for you.\n" +
    "- Work loop: boards_wait_for_work({board} or {project,branch}) → for each capsule: boards_set_status " +
    "working → fix the app → push a new set version (tools boards push) → boards_attach_after → boards_reply " +
    "(1-3 lines) → boards_set_status in_review. NEVER set resolved — that verdict belongs to the user.\n" +
    "- ALWAYS scope wait/list calls to YOUR board or repo+branch; items on other boards belong to other " +
    "sessions.\n" +
    '- A 409 "cancelled" on any write means the user withdrew the item: revert its changes, no reply, move on.\n' +
    "- Prefer the `tools boards watch` CLI via a background Monitor for idle listening (zero token cost); use " +
    "boards_wait_for_work to DRAIN after a wake, with timeoutSec 1.";

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
        boards_list_boards: {
            description: "List dev-dashboard boards, optionally filtered by project.",
            inputSchema: LIST_BOARDS_SCHEMA as unknown as Record<string, unknown>,
            handler: async (args) => handleListBoards(args as { project?: string }),
        },
        boards_list_sets: {
            description: "List artifact-set versions for a project (optionally scoped to a branch).",
            inputSchema: LIST_SETS_SCHEMA as unknown as Record<string, unknown>,
            handler: async (args) => handleListSets(args as { project: string; branch?: string }),
        },
        boards_get_set: {
            description:
                "Fetch one set version's file manifest (project/branch/selector — selector is a version " +
                "number, 'latest', a set name, or a set key).",
            inputSchema: GET_SET_SCHEMA as unknown as Record<string, unknown>,
            handler: async (args) => handleGetSet(args as { project: string; branch: string; selector: string }),
        },
        boards_list_work: {
            description:
                "FIFO work queue of board annotations. Filter by status/board/project+branch — always scope " +
                "to YOUR board or repo+branch.",
            inputSchema: LIST_WORK_SCHEMA as unknown as Record<string, unknown>,
            handler: async (args) =>
                handleListWork(args as { status?: string; board?: string; project?: string; branch?: string }),
        },
        boards_get_annotation: {
            description: "Fetch one annotation's full detail — status, region, thread, revisions, attempts.",
            inputSchema: GET_ANNOTATION_SCHEMA as unknown as Record<string, unknown>,
            handler: async (args) => handleGetAnnotation(args as { id: number }),
        },
        boards_get_capsule: {
            description:
                "Fetch the compact markdown work-brief for one annotation (ask, region, image URL, thread, " +
                "protocol reminder) — the same capsule delivered by boards_wait_for_work.",
            inputSchema: GET_CAPSULE_SCHEMA as unknown as Record<string, unknown>,
            handler: async (args) => handleGetCapsule(args as { id: number }),
        },
        boards_set_status: {
            description:
                "Move an annotation to open/working/in_review. NEVER set resolved — that verdict is user-only " +
                "(not offered by this tool's schema).",
            inputSchema: SET_STATUS_SCHEMA as unknown as Record<string, unknown>,
            handler: async (args) => handleSetStatus(args as { id: number; status: "open" | "working" | "in_review" }),
        },
        boards_reply: {
            description: "Post a short reply (1-3 lines) to an annotation's thread, authored as claude.",
            inputSchema: REPLY_SCHEMA as unknown as Record<string, unknown>,
            handler: async (args) => handleReply(args as { id: number; text: string }),
        },
        boards_attach_after: {
            description:
                "Attach a pushed set version's file as the 'after' attempt for an annotation (project/branch/" +
                "selector/file — selector is a version number, 'latest', a set name, or a set key).",
            inputSchema: ATTACH_AFTER_SCHEMA as unknown as Record<string, unknown>,
            handler: async (args) =>
                handleAttachAfter(
                    args as {
                        id: number;
                        project: string;
                        branch: string;
                        selector: string;
                        file: string;
                        commit?: string;
                    }
                ),
        },
        boards_highlight: {
            description:
                "Draw an amber rectangle stroke on the annotation's card, defaulting to the annotation's own " +
                "region — a visual pointer back to what you're addressing.",
            inputSchema: HIGHLIGHT_SCHEMA as unknown as Record<string, unknown>,
            handler: async (args) =>
                handleHighlight(args as { id: number; x?: number; y?: number; w?: number; h?: number; color?: string }),
        },
        boards_wait_for_work: {
            description:
                "Block (one long-poll pass, up to timeoutSec) for open board annotations in scope. ALWAYS pass " +
                "{board} or {project[, branch]} — unscoped waits belong to other sessions. A 409 means another " +
                "session already holds a live listener on this scope.",
            inputSchema: WAIT_FOR_WORK_SCHEMA as unknown as Record<string, unknown>,
            handler: async (args) =>
                handleWaitForWork(args as { board?: string; project?: string; branch?: string; timeoutSec?: number }),
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
