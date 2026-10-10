import { loadConfig as loadQuestionConfig } from "@app/question/lib/config";
import { decisionNudge, inboxInstructions, inboxSendDescription } from "@app/question/lib/inbox-guidance";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { env } from "@genesiscz/utils/env/envVariables";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { type NativeInboxState, nativeInboxState } from "@genesiscz/utils/macos/native-inbox";
import {
    type CallToolResult,
    type ListToolsResult,
    ProtocolError,
    ProtocolErrorCode,
    Server,
} from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { ANNOTATE_IMAGE_INPUT_SCHEMA, type AnnotateImageArgs, handleAnnotateImage } from "./tools/annotate-image";
import {
    HANDOFF_ACTION_DESCRIPTION,
    HANDOFF_ACTION_INPUT_SCHEMA,
    HANDOFF_GET_DESCRIPTION,
    HANDOFF_GET_INPUT_SCHEMA,
    HANDOFF_LIST_DESCRIPTION,
    HANDOFF_LIST_INPUT_SCHEMA,
    HANDOFF_POST_DESCRIPTION,
    HANDOFF_POST_INPUT_SCHEMA,
    type HandoffActionArgs,
    type HandoffGetArgs,
    type HandoffListArgs,
    type HandoffPostArgs,
    handleHandoffAction,
    handleHandoffGet,
    handleHandoffList,
    handleHandoffPost,
} from "./tools/handoff";
import { handleInboxSend, INBOX_SEND_INPUT_SCHEMA, type InboxSendArgs } from "./tools/inbox-send";
import { handleQuestionAnswer, QUESTION_ANSWER_INPUT_SCHEMA, type QuestionAnswerArgs } from "./tools/question-answer";
import {
    handleQuestionCancel,
    handleQuestionPoll,
    handleQuestionPost,
    handleQuestionRespond,
    handleQuestionTokens,
    handleQuestionWait,
    QUESTION_CANCEL_DESCRIPTION,
    QUESTION_CANCEL_INPUT_SCHEMA,
    QUESTION_POLL_DESCRIPTION,
    QUESTION_POLL_INPUT_SCHEMA,
    QUESTION_POST_INPUT_SCHEMA,
    QUESTION_RESPOND_DESCRIPTION,
    QUESTION_RESPOND_INPUT_SCHEMA,
    QUESTION_TOKENS_DESCRIPTION,
    QUESTION_TOKENS_INPUT_SCHEMA,
    QUESTION_WAIT_DESCRIPTION,
    QUESTION_WAIT_INPUT_SCHEMA,
    type QuestionCancelArgs,
    type QuestionPollArgs,
    type QuestionPostArgs,
    type QuestionRespondArgs,
    type QuestionTokensArgs,
    type QuestionWaitArgs,
    questionPostDescription,
} from "./tools/question-post";
import {
    handleQuestionUpdate,
    QUESTION_UPDATE_DESCRIPTION,
    QUESTION_UPDATE_INPUT_SCHEMA,
} from "./tools/question-update";

const log = logger.child({ component: "claude:mcp" });

const QUESTION_ANSWER_DESCRIPTION =
    "Preserve an important user question together with your COMPLETE answer (markdown ok) to the local " +
    "question store for later review. Use when the user directly asks a question worth keeping — rationale " +
    '("why did you choose X over Y"), design/architecture decisions, "how does Y work", tradeoff explanations ' +
    "— or right after you answer a substantive question/directive/status-nudge the user interjected " +
    'mid-session. Not for routine task instructions you simply execute or pure acknowledgements ("ok", "thanks").';

/** What the instruction and description texts depend on. Both are read once, when the harness starts the server. */
export interface InstructionContext {
    /** The question config's opt-in (`tools question config --ask-via-question-tool`). */
    askViaQuestionTool: boolean;
    /** This Mac's native inbox; see the precedence in src/question/lib/inbox-guidance.ts. */
    inboxState: NativeInboxState;
}

/**
 * The server instructions, read once when the server starts, so the inbox state they name is a snapshot: the note
 * each post returns carries the live one. Without the native app (`none`) they say nothing about the inbox.
 */
export function serverInstructions({ askViaQuestionTool, inboxState }: InstructionContext): string {
    const inbox = inboxInstructions(inboxState);

    return (
        "Genesis Tools — question/answer server. TWO question surfaces, opposite directions:\n\n" +
        (inbox ? `${inbox}\n\n` : "") +
        "1. ASK THE USER (blocking, they answer): `question_post` creates a PENDING form — a question you " +
        "need decided before you can continue. It lands on the dev-dashboard /qa Pending section and raises a " +
        "notification. Default is NON-BLOCKING: you get a form id immediately and collect the answer with " +
        "`question_wait` (returns waiter: answered | timeout | cancelled | budget_exhausted | not_found) or " +
        "`question_poll` (no ids = everything still pending). `question_cancel` withdraws a form you no longer " +
        "need. " +
        "`question_respond` submits an answer — the USER normally does that on the dashboard, so use it only " +
        "for automation or to relay an answer they gave you elsewhere; never invent one. Pass `wait: true` on " +
        "question_post only when you genuinely cannot proceed, because a blocking-by-default ask hangs agent " +
        `loops. Same surface from the CLI: \`${toolCommand("question")} ask|wait|poll|answer|cancel\` (the CLI \`answer\` verb ` +
        "is `question_respond` here). Answering a form ALSO writes it into the Q→A history below, so /qa stays " +
        "one list.\n" +
        'DECISIONS AND TODOS: a `question_post` item with `type: "decision"` or `type: "todo"` is not a form. ' +
        "It is numbered in this session's decision log (❓ DECISION N, TODO N; numbers never reused) and the " +
        "result is the markdown section to paste into your reply. " +
        decisionNudge({ state: inboxState, askViaQuestionTool }) +
        "Record " +
        "progress (acknowledged, implemented, commit refs, verdict, comments, a copy of a chat answer) with " +
        `\`question_update\`, several items per call. CLI: \`${toolCommand("question ask", "--json", "-")}\`, ` +
        `\`${toolCommand("question")} list|update|answers|answer|draft|send\`.\n` +
        'INLINE TOKENS: item text may carry {{kind key="value"}} tokens (lines, file, symbol, diff, tail, json, ' +
        "cmd, url, image, pr-thread), resolved into real content when the item is saved; `question_tokens` lists " +
        "them and previews a text. To correct an unanswered item, post it again with `supersedes: <id>`.\n\n" +
        "2. LOG YOUR OWN ANSWER (after the fact, no waiting): `question_answer`, described next.\n\n" +
        'Screenshot evidence goes in optional images: ["/absolute/local/image.png"], or in attachments: [{type: ' +
        '"image", path: "/absolute/local/image.png", label: "Result"}] (the same for question_post items). ' +
        "PNG/JPEG/WebP files are validated and copied into durable storage. For comparison, " +
        'add comparison: {group: "layout", role: "before" or "after"}. Keep refs for ordinary source references.\n\n' +
        "WHEN TO USE THE question_answer TOOL:\n" +
        '- The user directly asks a question important enough to preserve for later review: rationale ("why did ' +
        'you choose X over Y"), design/architecture decisions, "how does Y work", tradeoff explanations.\n' +
        "- Immediately AFTER you answer a substantive question, directive, or status-nudge the user interjected " +
        'mid-session (e.g. "what\'s left from the plan?", "pushed yet?", "did the tests pass?") — so the answer ' +
        "isn't lost in scrollback.\n" +
        "- Whenever the user invokes the /question skill directly.\n\n" +
        "Call it with the user's question, your COMPLETE answer (markdown ok), a tag (question | directive | " +
        "action), and optional refs. It persists to the local question store, browsable later with " +
        `\`${toolCommand("question log")}\` / \`${toolCommand("question tail")}\`.\n\n` +
        "DO NOT use for: routine task instructions you simply execute, pure acknowledgements " +
        '("ok", "thanks", "continue"), or trivial lookups not worth preserving.\n\n' +
        "HANDOFFS (cross-agent task handoff): `handoff_post` creates. `handoff_get` reads. `handoff_list` lists. " +
        "`handoff_action` changes. To delegate work, handoff_post {title, tasks} → copy the returned `paste` block " +
        "into the receiving agent's chat. Address it with target {sessionId|sessionName|agent}, where agent is the " +
        "intended RECIPIENT harness (claude | codex | grok | copilot), and give it a readable name (or let one be " +
        'derived from the title) so it can be fetched as handoff_get {name: "fix-active-filter"}; a name shared by ' +
        "several handoffs is refused with the candidate ids instead of guessing. " +
        'Receiving agent: handoff_get {id or name} (default include:["tasks"] — full task ' +
        "array) → READ warnings[] FIRST: it fires when the handoff is addressed to another session or another " +
        "harness, and then the task is not yours — do not work it unless your user explicitly says to. It is a " +
        "warning, never a block, and a session whose own identity cannot be detected is told the check was " +
        "unverifiable rather than being called a mismatch. → claim (claim: true) → work the tasks " +
        "→ handoff_action check_task with proof per task (deny_task with reason for tasks you can't do; " +
        "uncheck_task keeps prior proof) → " +
        'finish_handoff when all resolved. Pass include:["events"] on handoff_get for a bare {events, info} ' +
        "activity trace (editId-free; each event carries `outcome` — a refused action is journaled with " +
        "outcome.applied false and the reason, so the trace never reads as though it happened). " +
        "handoff_list is never recipient-filtered by default; agent: '<harness>' and session: '<id-or-name>' are " +
        "opt-in filters on the intended recipient, usable alone or together. " +
        "Poster edits anytime from its own session via handoff_action " +
        "(add_tasks/modify_task/modify_handoff/cancel_handoff); from other sessions pass the editId. Progress is " +
        'live on the dev-dashboard /qa "Agent tasks" tab (SSE via /api/qa/stream type=handoff).\n\n' +
        `JEV (capability \`jev\`, read-only, the same tools \`${toolCommand("jev mcp")}\` serves alone): \`jev_route\` maps a plain ` +
        "request to one GenesisTools command line without running it; `jev_compact` shrinks a transcript, log or " +
        "diff with Jev-judged drops; `jev_verify` judges claims against a document per template " +
        "(`jev_verify_templates` lists them). Every result is JSON text. None of them acts on the machine."
    );
}

export interface ToolEntry {
    description: string;
    inputSchema: Record<string, unknown>;
    /** Returns the text content. `context.signal` aborts when the client cancels the call. */
    handler: (args: Record<string, unknown>, context?: { signal?: AbortSignal }) => Promise<string>;
}

/** `inbox_send` exists only on a Mac with the native inbox: users without the app never see it. */
function inboxEntries(inboxState: NativeInboxState): Record<string, ToolEntry> {
    if (inboxState === "none") {
        return {};
    }

    return {
        inbox_send: {
            description: inboxSendDescription(inboxState),
            inputSchema: INBOX_SEND_INPUT_SCHEMA as unknown as Record<string, unknown>,
            handler: async (args) => SafeJSON.stringify(await handleInboxSend(args as unknown as InboxSendArgs)),
        },
    };
}

function buildToolRegistry(context: InstructionContext): Record<string, ToolEntry> {
    return {
        question_answer: {
            description: QUESTION_ANSWER_DESCRIPTION,
            inputSchema: QUESTION_ANSWER_INPUT_SCHEMA as unknown as Record<string, unknown>,
            handler: async (args) => {
                const r = await handleQuestionAnswer(args as unknown as QuestionAnswerArgs);
                return SafeJSON.stringify(r);
            },
        },
        ...inboxEntries(context.inboxState),
        question_post: {
            description: questionPostDescription(context),
            inputSchema: QUESTION_POST_INPUT_SCHEMA as unknown as Record<string, unknown>,
            handler: async (args) => handleQuestionPost(args as unknown as QuestionPostArgs),
        },
        question_wait: {
            description: QUESTION_WAIT_DESCRIPTION,
            inputSchema: QUESTION_WAIT_INPUT_SCHEMA as unknown as Record<string, unknown>,
            handler: async (args) => handleQuestionWait(args as unknown as QuestionWaitArgs),
        },
        question_poll: {
            description: QUESTION_POLL_DESCRIPTION,
            inputSchema: QUESTION_POLL_INPUT_SCHEMA as unknown as Record<string, unknown>,
            handler: async (args) => handleQuestionPoll(args as unknown as QuestionPollArgs),
        },
        question_respond: {
            description: QUESTION_RESPOND_DESCRIPTION,
            inputSchema: QUESTION_RESPOND_INPUT_SCHEMA as unknown as Record<string, unknown>,
            handler: async (args) => handleQuestionRespond(args as unknown as QuestionRespondArgs),
        },
        question_cancel: {
            description: QUESTION_CANCEL_DESCRIPTION,
            inputSchema: QUESTION_CANCEL_INPUT_SCHEMA as unknown as Record<string, unknown>,
            handler: async (args) => handleQuestionCancel(args as unknown as QuestionCancelArgs),
        },
        question_tokens: {
            description: QUESTION_TOKENS_DESCRIPTION,
            inputSchema: QUESTION_TOKENS_INPUT_SCHEMA as unknown as Record<string, unknown>,
            handler: async (args) => handleQuestionTokens(args as unknown as QuestionTokensArgs),
        },
        handoff_post: {
            description: HANDOFF_POST_DESCRIPTION,
            inputSchema: HANDOFF_POST_INPUT_SCHEMA as unknown as Record<string, unknown>,
            handler: async (args) => handleHandoffPost(args as unknown as HandoffPostArgs),
        },
        handoff_get: {
            description: HANDOFF_GET_DESCRIPTION,
            inputSchema: HANDOFF_GET_INPUT_SCHEMA as unknown as Record<string, unknown>,
            handler: async (args) => handleHandoffGet(args as unknown as HandoffGetArgs),
        },
        handoff_list: {
            description: HANDOFF_LIST_DESCRIPTION,
            inputSchema: HANDOFF_LIST_INPUT_SCHEMA as unknown as Record<string, unknown>,
            handler: async (args) => handleHandoffList(args as unknown as HandoffListArgs),
        },
        handoff_action: {
            description: HANDOFF_ACTION_DESCRIPTION,
            inputSchema: HANDOFF_ACTION_INPUT_SCHEMA as unknown as Record<string, unknown>,
            handler: async (args) => handleHandoffAction(args as unknown as HandoffActionArgs),
        },
        question_update: {
            description: QUESTION_UPDATE_DESCRIPTION,
            inputSchema: QUESTION_UPDATE_INPUT_SCHEMA,
            handler: async (args) => handleQuestionUpdate(args),
        },
        annotate_image: {
            description:
                "Draw annotations onto an EXISTING image from a JSON plan — rounded-rect highlights, boxes, " +
                "ellipses, arrows, label chips, blur redaction, crop (applied last), and coordinate grids. " +
                "Coordinates are natural image pixels; works on any capture source (playwright, peekaboo, " +
                "screencapture) — annotation is capture-agnostic post-processing. Writes an annotated COPY " +
                "(never mutates the input) and returns the output path — Read it to verify, then share or " +
                "attach it.",
            inputSchema: ANNOTATE_IMAGE_INPUT_SCHEMA as unknown as Record<string, unknown>,
            handler: async (args) => handleAnnotateImage(args as unknown as AnnotateImageArgs),
        },
    };
}

/** The blocking ask surface, named explicitly — see CAPABILITY_MATCHERS. */
const QUESTION_ASK_TOOLS = new Set([
    "question_post",
    "question_wait",
    "question_poll",
    "question_respond",
    "question_cancel",
    "question_update",
    "question_tokens",
]);

/**
 * `decision` predates the merge into question_post: a config that enabled it for the decision
 * tools still gets what posting and updating a decision needs, without the rest of the ask surface.
 */
const DECISION_TOOLS = new Set(["question_post", "question_poll", "question_update", "question_tokens"]);

/**
 * Known capability names, keyed to what counts as membership.
 *
 * `question_ask` is an explicit SET rather than a prefix: `question_` also matches
 * `question_answer`, so enabling only the blocking ask surface silently exposed the
 * history-recording tool as well, which is the separation this map exists to enforce.
 */
const CAPABILITY_MATCHERS: Record<string, (name: string) => boolean> = {
    // inbox_send writes the same after-the-fact Q→A store as question_answer and blocks nobody, so the existing
    // `question_answer` configs (every harness entry on this Mac uses it) get it without an edit.
    question_answer: (name) => name === "question_answer" || name === "inbox_send",
    inbox: (name) => name === "inbox_send",
    question_ask: (name) => QUESTION_ASK_TOOLS.has(name),
    handoff: (name) => name.startsWith("handoff_"),
    decision: (name) => DECISION_TOOLS.has(name),
    annotate: (name) => name.startsWith("annotate_"),
    jev: (name) => name.startsWith("jev_"),
};

/**
 * Filters the tool registry by a capability list (comma-delimited in GENESIS_TOOLS_MCP_CAPABILITIES for
 * stdio, or the capabilities header over HTTP, e.g. "question_answer,handoff"). Undefined -> every
 * capability enabled (unchanged default). No default from the env: an HTTP request without the header
 * passes `undefined`, and the gateway's own environment must not narrow it.
 */
export function filterRegistryByCapabilities(
    registry: Record<string, ToolEntry>,
    capabilities: string[] | undefined
): Record<string, ToolEntry> {
    if (capabilities === undefined) {
        return registry;
    }

    const enabled = capabilities
        .map((capability) => CAPABILITY_MATCHERS[capability])
        .filter((matcher): matcher is (name: string) => boolean => matcher !== undefined);

    return Object.fromEntries(Object.entries(registry).filter(([name]) => enabled.some((matches) => matches(name))));
}

const registries = new Map<string, Record<string, ToolEntry>>();
let jevEntries: Promise<Record<string, ToolEntry>> | undefined;

/**
 * The Jev tools import the evaluation stack (about 80 MB resident, measured 2026-10-01), so they load
 * only for a capability list that can expose them: unset (everything) or one naming `jev`.
 */
function loadJevEntries(): Promise<Record<string, ToolEntry>> {
    jevEntries ??= import("@app/jev/mcp/genesis-tools").then((module) => module.jevToolEntries());
    return jevEntries;
}

/** One registry per instructions variant; a resident server builds it once, not per request. */
async function toolRegistry(
    context: InstructionContext,
    capabilities: string[] | undefined
): Promise<Record<string, ToolEntry>> {
    const withJev = capabilities === undefined || capabilities.includes("jev");
    const key = `${context.askViaQuestionTool}:${context.inboxState}:${withJev}`;
    let registry = registries.get(key);
    if (!registry) {
        registry = {
            ...(withJev ? await loadJevEntries() : {}),
            ...buildToolRegistry(context),
        };
        registries.set(key, registry);
    }

    return registry;
}

/**
 * The genesis-tools MCP server for one stdio connection or one HTTP request. `runCall` wraps every
 * tool handler; the resident HTTP server uses it to run the handler as the calling session.
 * `inboxState` is injected by tests; production reads this Mac's (remembered for 15 s across requests).
 */
export async function createGenesisToolsServer(opts: {
    capabilities: string[] | undefined;
    runCall?: <T>(fn: () => Promise<T>) => Promise<T>;
    inboxState?: NativeInboxState;
}): Promise<{ server: Server; tools: string[]; askViaQuestionTool: boolean; inboxState: NativeInboxState }> {
    const context: InstructionContext = {
        askViaQuestionTool: loadQuestionConfig().askViaQuestionTool === true,
        inboxState: opts.inboxState ?? nativeInboxState(),
    };
    const registry = filterRegistryByCapabilities(await toolRegistry(context, opts.capabilities), opts.capabilities);
    const runCall = opts.runCall ?? ((fn) => fn());
    const server = new Server(
        { name: "genesis-tools", version: "1.0.0" },
        { capabilities: { tools: {} }, instructions: serverInstructions(context) }
    );

    server.setRequestHandler(
        "tools/list",
        async (): Promise<ListToolsResult> => ({
            tools: Object.entries(registry).map(([name, t]) => ({
                name,
                description: t.description,
                inputSchema: t.inputSchema as ListToolsResult["tools"][number]["inputSchema"],
            })),
        })
    );

    server.setRequestHandler("tools/call", async (request, context): Promise<CallToolResult> => {
        const entry = registry[request.params.name];
        if (!entry) {
            throw new ProtocolError(ProtocolErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
        }

        try {
            const text = await runCall(() =>
                entry.handler((request.params.arguments ?? {}) as Record<string, unknown>, {
                    signal: context.mcpReq.signal,
                })
            );
            return { content: [{ type: "text" as const, text }] };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log.warn({ err, tool: request.params.name }, "mcp tool handler failed");
            return {
                content: [{ type: "text" as const, text: `${request.params.name} failed: ${message}` }],
                isError: true,
            };
        }
    });

    return { server, tools: Object.keys(registry), ...context };
}

export async function startMcpServer(): Promise<void> {
    const capabilities = env.tools.getMcpCapabilities();
    const { server, tools, askViaQuestionTool, inboxState } = await createGenesisToolsServer({ capabilities });
    log.info(
        { capabilities: capabilities ?? "all", tools, askViaQuestionTool, inboxState },
        "genesis-tools MCP tool registry resolved"
    );

    const transport = new StdioServerTransport();
    await server.connect(transport);
    log.info("genesis-tools MCP server started (stdio)");
}
