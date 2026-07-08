import { logger } from "@app/logger";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
    handleArrange,
    handleAskBoard,
    handleComposeBoard,
    handleGetTemplates,
    handleListProjects,
    handleListSections,
    handleScrapeBoard,
    handleUpdateCards,
    handleUpdateSet,
} from "./tools/boards/compose-tools";
import {
    handleGetAnnotation,
    handleGetCapsule,
    handleGetSet,
    handleListBoards,
    handleListSets,
    handleListWork,
} from "./tools/boards/read-tools";
import {
    ARRANGE_SCHEMA,
    type ArrangeMode,
    ASK_BOARD_SCHEMA,
    ATTACH_AFTER_SCHEMA,
    COMPOSE_BOARD_SCHEMA,
    GET_ANNOTATION_SCHEMA,
    GET_CAPSULE_SCHEMA,
    GET_SET_SCHEMA,
    GET_TEMPLATES_SCHEMA,
    HIGHLIGHT_SCHEMA,
    LIST_BOARDS_SCHEMA,
    LIST_PROJECTS_SCHEMA,
    LIST_SECTIONS_SCHEMA,
    LIST_SETS_SCHEMA,
    LIST_WORK_SCHEMA,
    REPLY_SCHEMA,
    SCRAPE_BOARD_SCHEMA,
    SET_STATUS_SCHEMA,
    UPDATE_CARDS_SCHEMA,
    UPDATE_SET_SCHEMA,
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
    "boards_wait_for_work to DRAIN after a wake, with timeoutSec 1.\n\n" +
    "BOARD VOCABULARY (AI expression layer): you can PRESENT on boards, not just answer. boards_compose_board " +
    "places a whole thought in ONE call — markdown text cards (roles: heading/idea/pro/con/risk), data-only viz " +
    "cards (table/matrix/flow/bars/timeline/line/stat — always cheaper than an HTML artifact), cluster frames " +
    "grouping a direction, wires, and anchored multiple-choice questions (options carry {label,hint,recommended}; " +
    "answers arrive staged and are only released onto the work wire once the user dispatches). Batch-or-bust: " +
    "never place cards one call at a time. Never send coordinates — pick a layout (column/row/grid) and use " +
    "boards_arrange to tidy (13 modes; save:true persists the layout so the server auto-reflows it forever). " +
    'JOURNEY SECTIONS: name board regions after customer journeys with kind "section" frames ("Onboarding", ' +
    '"Checkout") — always visible, auto-indexed (boards_list_sections), and every tool scopes to them: ' +
    'boards_compose_board {section}, boards_arrange {scope:"section:Name"}, boards_scrape_board {section} for ' +
    "an isolated digest. Sections are also the ITERATION surface: present the next pass of a journey as its own " +
    'section beside the current one (boards_compose_board {journey,pass:"next"}) instead of mixing takes ' +
    "together — boards_scrape_board {diff:[a,b]} then diffs two sections pairwise. boards_update_cards edits or " +
    "trashes only your own AI-layer cards (plus section frames) — the user's shots and notes are untouchable. " +
    "boards_ask_board asks a first-class multiple-choice question outside a compose batch. Call " +
    "boards_get_templates once before structuring a new board and start from a matching skeleton instead of " +
    "inventing structure.";

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
        boards_ask_board: {
            description:
                "Ask the operator a first-class multiple-choice question on a board — rendered as one-click " +
                "pills, optionally anchored to a card. The answer is STAGED until the operator dispatches, then " +
                'returns on the work wire as a {type:"choice"} item (boards_wait_for_work). An "Other" free-text ' +
                "escape is always added by the engine — pass only the real options, never hard-block off-" +
                "vocabulary answers.",
            inputSchema: ASK_BOARD_SCHEMA as unknown as Record<string, unknown>,
            handler: async (args) =>
                handleAskBoard(
                    args as {
                        board: string;
                        prompt: string;
                        options: Array<string | { label: string; hint?: string; recommended?: boolean }>;
                        multiSelect?: boolean;
                        cardId?: number;
                    }
                ),
        },
        boards_compose_board: {
            description:
                "Place a BATCH of AI-authored content on a board in one call — text blocks, notes, viz, sections " +
                "and questions, wired together. Batch-or-bust: compose the whole thought in ONE call (never one " +
                "card per call); the server owns geometry — never send coordinates. All-or-nothing: on 400 the " +
                "error carries {code,index} pointing at the bad item and nothing was placed.",
            inputSchema: COMPOSE_BOARD_SCHEMA as unknown as Record<string, unknown>,
            handler: async (args) =>
                handleComposeBoard(
                    args as {
                        board: string;
                        layout?: "column" | "row" | "grid";
                        anchorCardId?: number;
                        section?: string;
                        journey?: string;
                        pass?: number | "next";
                        cards?: unknown[];
                        edges?: unknown[];
                        questions?: unknown[];
                    }
                ),
        },
        boards_arrange: {
            description:
                "Auto-align board cards server-side — geometry is computed for you and lands as one atomic " +
                "layout event. Default scope is the AI expression layer; scope 'all' tidies everything; " +
                "'section:<Name>' reflows one journey section inside its frame. Pass save:true with a section " +
                "scope to persist the layout so the server auto-reflows it on every future change.",
            inputSchema: ARRANGE_SCHEMA as unknown as Record<string, unknown>,
            handler: async (args) =>
                handleArrange(
                    args as {
                        board: string;
                        mode: ArrangeMode;
                        save?: boolean;
                        sections?: string[];
                        scope?: string;
                        ids?: number[];
                        gap?: string | number;
                        padding?: string | number;
                        cols?: number;
                        sizing?: "natural" | "uniform";
                    }
                ),
        },
        boards_update_cards: {
            description:
                "Batch-edit YOUR OWN board layer — patch payload/geometry or remove cards you composed. " +
                "Restricted to AI-layer cards plus section frames: the user's shots and notes are untouchable, " +
                'a non-AI target 403s with {code:"not_ai_layer"}. Removals are soft (trashed, restorable via ' +
                "restore) — the response of a remove is your undo handle.",
            inputSchema: UPDATE_CARDS_SCHEMA as unknown as Record<string, unknown>,
            handler: async (args) =>
                handleUpdateCards(
                    args as {
                        board: string;
                        patch?: Array<{
                            id: number;
                            x?: number;
                            y?: number;
                            w?: number;
                            h?: number;
                            payload?: Record<string, unknown>;
                        }>;
                        remove?: number[];
                        restore?: number[];
                    }
                ),
        },
        boards_scrape_board: {
            description:
                "Read a WHOLE board as one structured testing digest — every media image (URL), note text and " +
                'annotation, connect-tool edges walked into ordered journey chains ("flow": [[A,B,C]]), and the ' +
                "journey sections summarized. Pass section to isolate the digest to one journey, or diff to " +
                "compare two sections pairwise (iteration diff). Images are absolute URLs — fetch them to SEE " +
                "each step.",
            inputSchema: SCRAPE_BOARD_SCHEMA as unknown as Record<string, unknown>,
            handler: async (args) => handleScrapeBoard(args as { board: string; section?: string; diff?: string[] }),
        },
        boards_list_sections: {
            description:
                "The automatic journey-section index of a board: every section (name, bounds, member count, " +
                "reading order, journey/pass when part of an iteration chain) plus journeys:[{journey,passes," +
                "latest}] — the one-call orientation on which journeys exist and where the latest pass is.",
            inputSchema: LIST_SECTIONS_SCHEMA as unknown as Record<string, unknown>,
            handler: async (args) => handleListSections(args as { board: string }),
        },
        boards_list_projects: {
            description: "List all projects known to the boards/sets library (name, branch count, set count).",
            inputSchema: LIST_PROJECTS_SCHEMA as unknown as Record<string, unknown>,
            handler: async () => handleListProjects(),
        },
        boards_update_set: {
            description:
                "Edit a set's mutable metadata: custom name and/or human title. Omitted fields stay untouched; " +
                'empty string ("") clears the field.',
            inputSchema: UPDATE_SET_SCHEMA as unknown as Record<string, unknown>,
            handler: async (args) =>
                handleUpdateSet(
                    args as { project: string; branch: string; selector: string; name?: string; title?: string }
                ),
        },
        boards_get_templates: {
            description:
                "The board template library (markdown): compose-ready skeletons for QA sessions, iteration " +
                "reviews, decision maps, metrics dashboards and presentation decks. Fetch ONCE before structuring " +
                "a new board and start from the matching template instead of inventing structure.",
            inputSchema: GET_TEMPLATES_SCHEMA as unknown as Record<string, unknown>,
            handler: async () => handleGetTemplates(),
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
