import { executeHandoffActions, getHandoff, type HandoffDeps, listHandoffs, postHandoff } from "@app/handoff/executor";
import type { HandoffActionInput, HandoffTarget, HandoffTaskInput } from "@app/handoff/types";
import { SafeJSON } from "@genesiscz/utils/json";

export interface HandoffPostArgs {
    title: string;
    name?: string;
    description?: string;
    tasks: HandoffTaskInput[];
    target?: HandoffTarget;
    refs?: string[];
}

export interface HandoffGetArgs {
    id?: string;
    name?: string;
    claim?: boolean;
    unclaim?: boolean;
    include?: string[];
}

export interface HandoffListArgs {
    limit?: number;
    offset?: number;
    mine?: boolean;
    open?: boolean;
    project?: string;
    agent?: string;
    session?: string;
    include?: string[];
}

export interface HandoffActionArgs {
    id?: string;
    name?: string;
    editId?: string;
    actions: HandoffActionInput[];
    include?: string[];
}

function render(value: unknown): string {
    return SafeJSON.stringify(value, { strict: true }, 2);
}

const DEFAULT_MCP_INCLUDE = ["tasks"];

export async function handleHandoffPost(args: HandoffPostArgs, deps: HandoffDeps = {}): Promise<string> {
    return render(postHandoff(args, deps));
}

export async function handleHandoffGet(args: HandoffGetArgs, deps: HandoffDeps = {}): Promise<string> {
    return render(getHandoff({ ...args, include: args.include ?? DEFAULT_MCP_INCLUDE }, deps));
}

export async function handleHandoffList(args: HandoffListArgs, deps: HandoffDeps = {}): Promise<string> {
    return render(listHandoffs(args, deps));
}

export async function handleHandoffAction(args: HandoffActionArgs, deps: HandoffDeps = {}): Promise<string> {
    return render(executeHandoffActions({ ...args, include: args.include ?? DEFAULT_MCP_INCLUDE }, deps));
}

export const HANDOFF_POST_DESCRIPTION =
    "Create a handoff — a task list for ANOTHER agent session (cross-repo/cross-project ok). Give title and " +
    "tasks (each has text and optional acceptanceCriteria); optional description (context body), target " +
    "{sessionId|sessionName|agent}, refs, and name. target.agent names the INTENDED RECIPIENT harness " +
    "(claude | codex | grok | copilot) — a session on another harness gets a warning telling it not to work " +
    "the handoff; it never says who wrote it (that is postedBy). name is a readable slug the receiver can " +
    "fetch by (handoff_get { name }); omit it and it is derived from the title. Returns the handoff with " +
    "final task ids, an editId (edit credential for other sessions — your own session edits without it), and " +
    "a `paste` block: paste it into the receiving agent's chat. To change anything later, call handoff_action.";

export const HANDOFF_GET_DESCRIPTION =
    "Read a handoff by id (from a paste block or handoff_list) or by its readable name — pass either as id, " +
    "or the name as name. A unique name resolves; a name carried by several handoffs is refused WITH the " +
    "candidate ids so you re-call with the id you meant; passing an id and a name that disagree is an error. " +
    "ALWAYS read warnings[] first: it fires when the handoff is addressed to another session (explicit " +
    "target sessionId) or another harness (target.agent), and then this task is NOT yours — do not work it " +
    "unless your user explicitly tells you to. A warning is not a block: user-authorized cross-target work " +
    "stays possible, and a caller whose own identity cannot be detected is told the check was unverifiable " +
    "rather than being called a mismatch. Pass claim: true to claim it for this " +
    "session before working, unclaim: true to release it. Several sessions may claim the same handoff " +
    "(co-owning). If your session IS the target sessionId it auto-claims (response says so; undo with " +
    "unclaim: true) — except under a target.agent this session is not, which never auto-claims. If this " +
    "session posted the handoff (same sessionId — sessions are ephemeral, identity " +
    "is per-session not per-human), the response also returns your editId; if the posting session is gone " +
    "and the editId is lost, your user can read it on the dev-dashboard /qa Agent-tasks tab. info[] always " +
    "states where you stand and the one next step. After claiming, record work via handoff_action check_task. " +
    'Optional include: string[] scopes the response (default ["tasks"] — full task array). Sections: tasks, ' +
    'claimedBy, comments, attachments, events, postedBy, postedByContext. Special: include:["events"] alone ' +
    "returns {events, info} without the handoff envelope.";

export const HANDOFF_LIST_DESCRIPTION =
    "List recent handoffs, newest-updated first — ALL projects by default and NEVER filtered by recipient " +
    "unless you ask; project: '<name>' narrows. " +
    "open: true → only unresolved (not done/cancelled); mine: true → posted by, claimed by, or targeted at " +
    "this session; limit (default 20) + offset page through. Two opt-in recipient filters, usable alone or " +
    "together: agent: 'codex' keeps handoffs whose target.agent is that harness (spellings are canonical, so " +
    "'claude-code' finds 'claude'), and session: '<id-or-name>' keeps handoffs whose target.sessionId matches " +
    "exactly or by leading-segment abbreviation, or whose target.sessionName matches. Both read the INTENDED " +
    "RECIPIENT, never the poster. Each row carries name, target and warnings[] (present only when this " +
    "session is not the intended recipient). Open rows are detailed, claimed rows concise. " +
    'Optional include: ["tasks"] adds a task array per row with proof PREVIEWS (answer clipped, context dropped, ' +
    "id lists capped) — call handoff_get for full proofs. Other include values are ignored with an info line. " +
    "Use the id or the name with handoff_get.";

export const HANDOFF_ACTION_DESCRIPTION =
    "Change a handoff, addressed by id or by readable name (same resolution rules as handoff_get) — tasks " +
    "and lifecycle (claim/unclaim also exist as a convenience on handoff_get; " +
    'identical effect). Ordered actions array; every action is an object { action: "<verb>", …verb fields } ' +
    "(payload-less verbs may be bare strings). Claimer verbs (be claimed, or start with {action:'claim'}): " +
    "claim, unclaim, check_task {taskId, proof:{answer, commitIds?, context?}}, uncheck_task {taskId} " +
    "(keeps prior proof on the task; clears checkedBy/checkedTs), " +
    "deny_task {taskId, reason}, undeny_task {taskId}, comment {text}, finish_handoff (rejected unless every " +
    "task is checked or denied — force: true overrides; undo via reopen_handoff). Poster verbs (from the " +
    "posting session, or with editId): add_tasks {tasks:[…]}, modify_task {taskId, text?, acceptanceCriteria?}, " +
    "modify_handoff {title?, name?, description?, target?, refs?}, deny_task, undeny_task, check_task, comment, " +
    "cancel_handoff, reopen_handoff (undoes finish OR cancel; also allowed for the claimer whose own finish " +
    "closed it). attach_file {path, taskId?, note?} attaches a local file (screenshot, log) to the handoff or " +
    "a task. Common short forms are accepted as aliases (done/finish→finish_handoff, check→check_task, " +
    "add→add_tasks, modify→modify_task, deny→deny_task, uncheck→uncheck_task). An unrecognized verb is " +
    'rejected with the full valid-verb list. Optional include: string[] scopes the returned handoff (default ["tasks"]; ' +
    'same sections as handoff_get; include:["events"] alone is not special here — events are added on the handoff object).';

const INCLUDE_PROP = {
    type: "array",
    items: { type: "string" },
    description:
        "optional response sections — tasks | claimedBy | comments | attachments | events | postedBy | postedByContext. " +
        'Default on get/action: ["tasks"]. Unknown names → error listing valid sections.',
} as const;

const TASK_ITEM_SCHEMA = {
    type: "object",
    properties: {
        id: {
            type: "string",
            description: "optional task id — auto-assigned t<n> when omitted; final ids ALWAYS in the response",
        },
        text: { type: "string", description: "what to do — imperative, self-contained" },
        acceptanceCriteria: {
            type: "string",
            description: "how the worker knows the task is done — optional but strongly recommended",
        },
    },
    required: ["text"],
} as const;

const TARGET_SCHEMA = {
    type: "object",
    description:
        "who this handoff is FOR: exact sessionId auto-claims on its first get; sessionName only nudges (names aren't unique); agent names the recipient harness. Never describes the poster — that is postedBy",
    properties: {
        sessionId: { type: "string", description: "exact receiving sessionId — auto-claims on its first handoff_get" },
        sessionName: { type: "string", description: "receiving session's name — nudge only, never auto-claims" },
        agent: {
            type: "string",
            description:
                "intended RECIPIENT harness — claude | codex | grok | copilot. A session on another harness is warned off and never auto-claims. Undocumented values are stored as given but can never raise a warning",
        },
    },
} as const;

export const HANDOFF_POST_INPUT_SCHEMA = {
    type: "object",
    properties: {
        title: { type: "string", description: "short imperative title of the work being handed off" },
        name: {
            type: "string",
            description:
                "readable name the receiver can fetch by (handoff_get { name }) — slugified (lowercase, hyphens); omit it and a slug of the title is used. Not the target session's name",
        },
        description: { type: "string", description: "markdown body — the why/context the worker needs" },
        tasks: { type: "array", minItems: 1, items: TASK_ITEM_SCHEMA, description: "the checkable task list (≥1)" },
        target: TARGET_SCHEMA,
        refs: {
            type: "array",
            items: { type: "string" },
            description: "file paths / PR / board URLs the worker will need",
        },
    },
    required: ["title", "tasks"],
} as const;

export const HANDOFF_GET_INPUT_SCHEMA = {
    type: "object",
    properties: {
        id: {
            type: "string",
            description:
                "the handoff id from a paste block or handoff_list — h_ prefix optional, whitespace ok; a readable name is accepted here too",
        },
        name: {
            type: "string",
            description:
                "readable name instead of an id — a unique name resolves, an ambiguous one is refused with the candidate ids, and a name that disagrees with a supplied id is an error",
        },
        claim: {
            type: "boolean",
            description: "claim this handoff for the calling session before working (co-owning is allowed)",
        },
        unclaim: { type: "boolean", description: "release ONLY this session's claim (no-op if not claimed)" },
        include: INCLUDE_PROP,
    },
} as const;

export const HANDOFF_LIST_INPUT_SCHEMA = {
    type: "object",
    properties: {
        limit: { type: "number", description: "max rows (default 20)" },
        offset: { type: "number", description: "skip this many rows (paging)" },
        mine: {
            type: "boolean",
            description: "only handoffs posted by, claimed by, or targeted at this session",
        },
        open: { type: "boolean", description: "only unresolved handoffs (status open or claimed)" },
        project: { type: "string", description: "narrow to one project (default: all projects)" },
        agent: {
            type: "string",
            description:
                "opt-in — only handoffs whose target.agent is this harness (claude | codex | grok | copilot; spellings canonicalized). Off by default; combines with session",
        },
        session: {
            type: "string",
            description:
                "opt-in — only handoffs whose target.sessionId matches this id (exactly or by leading-segment abbreviation) or whose target.sessionName matches it. Off by default; combines with agent",
        },
        include: {
            type: "array",
            items: { type: "string" },
            description:
                'optional — only "tasks" is honored on list rows (adds taskList with proof previews; handoff_get returns full proofs)',
        },
    },
} as const;

export const HANDOFF_ACTION_INPUT_SCHEMA = {
    type: "object",
    properties: {
        id: {
            type: "string",
            description: "the handoff id — h_ prefix optional, whitespace ok; a readable name resolves here too",
        },
        name: {
            type: "string",
            description: "readable name instead of an id — same resolution rules as handoff_get",
        },
        editId: {
            type: "string",
            description:
                "poster edit credential from handoff_post — only needed for poster verbs from a session other than the posting one; your user can read it on the dev-dashboard /qa Agent-tasks tab",
        },
        include: INCLUDE_PROP,
        actions: {
            type: "array",
            minItems: 1,
            description:
                'ordered — each action is { action: "<verb>", …verb fields } — e.g. { action: "check_task", taskId: "t1", proof: { answer: "…" } }; payload-less verbs may be plain strings',
            items: {
                anyOf: [
                    { type: "string", description: 'bare payload-less verb, e.g. "claim" or "finish_handoff"' },
                    {
                        type: "object",
                        properties: {
                            action: {
                                type: "string",
                                description: "the verb — see the tool description for the full list",
                            },
                            taskId: {
                                type: "string",
                                description: "the task's id from the handoff you read (t1, t2, …)",
                            },
                            proof: {
                                type: "object",
                                description: "check_task evidence",
                                properties: {
                                    answer: {
                                        type: "string",
                                        description:
                                            "what you did and how you verified it satisfies the acceptance criteria (tests run + results) — 1-3 sentences, markdown ok",
                                    },
                                    commitIds: {
                                        type: "array",
                                        items: { type: "string" },
                                        description: "commit SHAs implementing it, e.g. ['a1b2c3d']",
                                    },
                                    context: { type: "string", description: "optional side effects, caveats, links" },
                                    screenshots: {
                                        type: "array",
                                        items: { type: "string" },
                                        description:
                                            "absolute paths of screenshots proving it (e.g. the annotated PNG from tools control draw) — auto-ingested as attachments",
                                    },
                                    attachmentIds: {
                                        type: "array",
                                        items: { type: "string" },
                                        description: "ids of already-ingested attachments to link to this proof",
                                    },
                                },
                                required: ["answer"],
                            },
                            reason: {
                                type: "string",
                                description:
                                    "deny_task: why this task won't be done — shown struck-through with the task while denied (undeny_task clears it)",
                            },
                            force: {
                                type: "boolean",
                                description:
                                    "override cross-state guards: check a denied task, deny a checked task, or finish with unresolved tasks",
                            },
                            text: { type: "string", description: "comment text / modify_task replacement text" },
                            path: {
                                type: "string",
                                description:
                                    "attach_file: absolute path of the file to attach (screenshot, log, diff) — copied into the handoff's attachment store",
                            },
                            note: { type: "string", description: "attach_file: short caption for the attachment" },
                            screenshots: {
                                type: "array",
                                items: { type: "string" },
                                description:
                                    "comment: absolute screenshot paths — auto-ingested and linked to the comment",
                            },
                            attachmentIds: {
                                type: "array",
                                items: { type: "string" },
                                description: "comment: ids of already-ingested attachments to link",
                            },
                            tasks: {
                                type: "array",
                                items: TASK_ITEM_SCHEMA,
                                description: "add_tasks: new tasks to append (ids auto-assigned)",
                            },
                            acceptanceCriteria: {
                                type: "string",
                                description: "modify_task: replacement acceptance criteria",
                            },
                            title: { type: "string", description: "modify_handoff: replacement title" },
                            name: {
                                type: "string",
                                description:
                                    "modify_handoff: replacement readable name (slugified); null or an empty string clears it. A title edit never renames",
                            },
                            description: { type: "string", description: "modify_handoff: replacement description" },
                            target: TARGET_SCHEMA,
                            refs: {
                                type: "array",
                                items: { type: "string" },
                                description: "modify_handoff: replacement refs list",
                            },
                        },
                        required: ["action"],
                    },
                ],
            },
        },
    },
    required: ["actions"],
} as const;
