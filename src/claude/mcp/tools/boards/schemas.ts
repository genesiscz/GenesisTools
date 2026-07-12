// Hand-written JSON Schemas for the boards_* MCP tools, following
// QUESTION_ANSWER_INPUT_SCHEMA's shape (type: object, properties, required,
// additionalProperties: false). They all live here so descriptions stay reviewable
// in one file; tool descriptions themselves are registered alongside handlers in
// server.ts.

export const LIST_BOARDS_SCHEMA = {
    type: "object",
    properties: { project: { type: "string", description: "Filter by project name" } },
    additionalProperties: false,
} as const;

export const CREATE_BOARD_SCHEMA = {
    type: "object",
    properties: {
        slug: {
            type: "string",
            description: "Board slug (URL path segment): ^[a-z0-9][a-z0-9-]{0,63}$",
        },
        title: { type: "string", description: "Human title (defaults to the slug)" },
        project: { type: "string", description: "Project to file the board under" },
    },
    required: ["slug"],
    additionalProperties: false,
} as const;

export const LIST_SETS_SCHEMA = {
    type: "object",
    properties: { project: { type: "string" }, branch: { type: "string" } },
    required: ["project"],
    additionalProperties: false,
} as const;

export const GET_SET_SCHEMA = {
    type: "object",
    properties: {
        project: { type: "string" },
        branch: { type: "string" },
        selector: { type: "string", description: "version number | 'latest' | set name | set key" },
    },
    required: ["project", "branch", "selector"],
    additionalProperties: false,
} as const;

export const LIST_WORK_SCHEMA = {
    type: "object",
    properties: {
        status: { type: "string", enum: ["staged", "open", "working", "in_review", "resolved", "cancelled"] },
        board: { type: "string" },
        project: { type: "string" },
        branch: { type: "string" },
    },
    additionalProperties: false,
} as const;

export const GET_ANNOTATION_SCHEMA = {
    type: "object",
    properties: { id: { type: "number" } },
    required: ["id"],
    additionalProperties: false,
} as const;

export const GET_CAPSULE_SCHEMA = GET_ANNOTATION_SCHEMA;

export const SET_STATUS_SCHEMA = {
    type: "object",
    properties: {
        id: { type: "number" },
        // resolved is user-only by convention (plan §0.3 item 6) — deliberately absent here.
        status: { type: "string", enum: ["open", "working", "in_review"] },
    },
    required: ["id", "status"],
    additionalProperties: false,
} as const;

export const REPLY_SCHEMA = {
    type: "object",
    properties: {
        id: { type: "number" },
        text: { type: "string" },
    },
    required: ["id", "text"],
    additionalProperties: false,
} as const;

export const ATTACH_AFTER_SCHEMA = {
    type: "object",
    properties: {
        id: { type: "number" },
        project: { type: "string" },
        branch: { type: "string" },
        selector: { type: "string", description: "version number | 'latest' | set name | set key" },
        file: { type: "string", description: "path of the file within the set" },
        commit: { type: "string" },
    },
    required: ["id", "project", "branch", "selector", "file"],
    additionalProperties: false,
} as const;

export const HIGHLIGHT_SCHEMA = {
    type: "object",
    properties: {
        id: { type: "number" },
        x: { type: "number" },
        y: { type: "number" },
        w: { type: "number" },
        h: { type: "number" },
        color: { type: "string" },
    },
    required: ["id"],
    additionalProperties: false,
} as const;

export const WAIT_FOR_WORK_SCHEMA = {
    type: "object",
    properties: {
        board: { type: "string", description: "ALWAYS pass a scope: board, or project+branch" },
        project: { type: "string", description: "ALWAYS pass a scope: board, or project+branch" },
        branch: { type: "string" },
        timeoutSec: { type: "number", minimum: 1, maximum: 55 },
    },
    anyOf: [{ required: ["board"] }, { required: ["project"] }],
    additionalProperties: false,
} as const;

// ---- AI expression layer (compose/arrange/update_cards/scrape/sections/questions) ----

const optionItem = {
    anyOf: [
        { type: "string" },
        {
            type: "object",
            properties: {
                label: { type: "string" },
                hint: { type: "string" },
                recommended: { type: "boolean" },
            },
            required: ["label"],
            additionalProperties: false,
        },
    ],
} as const;

const composeCardKinds = [
    "text",
    "note",
    "shape",
    "viz",
    "cluster",
    "section",
    "step",
    "callout",
    "checklist",
    "compare",
    "wireframe",
] as const;

export const ASK_BOARD_SCHEMA = {
    type: "object",
    properties: {
        board: { type: "string", description: "Board slug (from boards_list_boards)" },
        prompt: { type: "string", description: "The question" },
        options: {
            type: "array",
            items: optionItem,
            description:
                "1-12 answer options — strings, or {label, hint?, recommended?} to carry tradeoffs (hint shows " +
                'on hover, recommended gets a hairline mark). An "Other" free-text escape is appended automatically.',
        },
        multiSelect: { type: "boolean", description: "Allow picking several options (default false)" },
        cardId: { type: "number", description: "Optional card id to anchor the question to (omit for board-level)" },
    },
    required: ["board", "prompt", "options"],
    additionalProperties: false,
} as const;

export const COMPOSE_BOARD_SCHEMA = {
    type: "object",
    properties: {
        board: { type: "string", description: "Board slug (from boards_list_boards)" },
        layout: {
            type: "string",
            enum: ["column", "row", "grid"],
            description: "How the batch flows: column (default — reading order), row, or grid (3 per row)",
        },
        anchorCardId: { type: "number", description: "Place the batch beside this existing card" },
        section: {
            type: "string",
            description:
                "Journey section name (see boards_list_sections): the batch lands INSIDE that frame, below its " +
                "existing content, and the frame grows to fit. Mutually exclusive with anchorCardId and journey.",
        },
        journey: {
            type: "string",
            description:
                'Pass-chain key ("checkout"): target a journey\'s ITERATION chain instead of a named section. ' +
                "Alone = the batch lands in the chain's LATEST pass (creates pass 1 if none).",
        },
        pass: {
            anyOf: [{ type: "string", enum: ["next"] }, { type: "number" }],
            description:
                'With journey: "next" CREATES the next pass section (auto-named, placed beside the previous ' +
                "pass, layout inherited); a number targets that existing pass. Omit = latest.",
        },
        cards: {
            type: "array",
            description:
                "Up to 60 cards. Give each a ref so edges/questions in the same call can reference it. kind " +
                '"text": payload {md, role: idea|note|pro|con|risk|heading|caption}. kind "note": payload {text}. ' +
                'kind "shape": payload {shape: rect|ellipse, color}. kind "viz": payload {viz, data, title?} — ' +
                "table {cols,rows}, matrix {x:[lo,hi],y:[lo,hi],points:[{label,x,y}]}, flow {steps:[label]}, " +
                "bars {items:[{label,value}]}, timeline {items:[{label,when}]}, line {series:[{label,points}],x?}, " +
                'stat {items:[{label,value,delta?,unit?}]}. kind "cluster": payload {title} — a frame; list member ' +
                'refs in "children". kind "section": payload {title} — a NAMED JOURNEY FRAME, always visible, ' +
                'auto-indexed (boards_list_sections); membership is spatial. kind "step" {n?, title, note?, ' +
                "status: todo|pass|fail, cardId?} — cardId references an EXISTING shot card for a live thumbnail. " +
                'kind "callout" {tone: info|warn|success|decision, md}. kind "checklist" {title?, items:[{text, ' +
                'done?}]}. kind "compare" {a:{cardId}, b:{cardId}}. kind "wireframe" {title?, device: phone|tablet' +
                "|web, fidelity?: lo|tokens, nodes:[{t, label?, …}]} — a lo-fi UI sketch (cheaper than an HTML " +
                "artifact): nodes render top-to-bottom; t: nav, tabbar, heading, text, button, input, img (h: s|m|" +
                "l), list (n), listitem, divider, chiprow, modal. Optional w/h override the per-kind default size.",
            items: {
                type: "object",
                properties: {
                    ref: { type: "string", description: "Batch-local handle for edges/questions/children" },
                    children: {
                        type: "array",
                        items: { type: "string" },
                        description: "cluster/section only: refs of batch cards to lay out inside this frame",
                    },
                    kind: { type: "string", enum: composeCardKinds },
                    payload: { type: "object", description: "Kind-specific payload (see cards description)" },
                    w: { type: "number" },
                    h: { type: "number" },
                },
                required: ["kind", "payload"],
                additionalProperties: false,
            },
        },
        edges: {
            type: "array",
            description: "Up to 40 wires between cards. from/to: a ref string from this batch, or a card id.",
            items: {
                type: "object",
                properties: {
                    from: { description: "Card ref (string) or existing card id (number)" },
                    to: { description: "Card ref (string) or existing card id (number)" },
                    label: { type: "string" },
                },
                required: ["from", "to"],
                additionalProperties: false,
            },
        },
        questions: {
            type: "array",
            description:
                "Up to 12 questions, optionally anchored to a batch card (cardRef) or existing card (cardId). " +
                "Same staged-answer mechanics as boards_ask_board.",
            items: {
                type: "object",
                properties: {
                    prompt: { type: "string" },
                    options: { type: "array", items: optionItem },
                    multiSelect: { type: "boolean" },
                    cardRef: { type: "string" },
                    cardId: { type: "number" },
                },
                required: ["prompt", "options"],
                additionalProperties: false,
            },
        },
    },
    required: ["board"],
    additionalProperties: false,
} as const;

export const ARRANGE_SCHEMA = {
    type: "object",
    properties: {
        board: { type: "string", description: "Board slug" },
        mode: {
            type: "string",
            enum: [
                "column",
                "row",
                "grid",
                "flow",
                "lanes",
                "masonry",
                "timeline",
                "timeaxis",
                "compare",
                "align-left",
                "align-top",
                "distribute-h",
                "distribute-v",
            ],
        },
        save: {
            type: "boolean",
            description:
                "With a section scope: persist this layout onto the section so the server auto-reflows it on " +
                "every future change",
        },
        sections: {
            type: "array",
            items: { type: "string" },
            description: 'mode "compare" only: exactly two section names to align side-by-side',
        },
        scope: {
            type: "string",
            description:
                'Which cards move: "ai" (default — the expression layer), "all", or "section:<Name>" ' +
                "(that journey's members, arranged inside the frame)",
        },
        ids: { type: "array", items: { type: "number" }, description: "Explicit card ids; overrides scope" },
        gap: {
            anyOf: [{ type: "string", enum: ["S", "M", "L"] }, { type: "number" }],
            description: "Spacing between cards: S (12), M (24, default), L (48) or explicit px 0-400",
        },
        padding: {
            anyOf: [{ type: "string", enum: ["S", "M", "L"] }, { type: "number" }],
            description: "Frame inner padding when scoped to a section (default 24)",
        },
        cols: { type: "number", description: "grid mode: cards per row (default 3)" },
        sizing: {
            type: "string",
            enum: ["natural", "uniform"],
            description: "uniform = every card takes the selection's max footprint; default natural",
        },
    },
    required: ["board", "mode"],
    additionalProperties: false,
} as const;

export type ArrangeMode = (typeof ARRANGE_SCHEMA)["properties"]["mode"]["enum"][number];

export const UPDATE_CARDS_SCHEMA = {
    type: "object",
    properties: {
        board: { type: "string", description: "Board slug" },
        patch: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    id: { type: "number" },
                    payload: {
                        type: "object",
                        description: 'Replacement payload (the "layer" marker is preserved automatically)',
                    },
                    x: { type: "number" },
                    y: { type: "number" },
                    w: { type: "number" },
                    h: { type: "number" },
                },
                required: ["id"],
                additionalProperties: false,
            },
        },
        remove: { type: "array", items: { type: "number" }, description: "Card ids to TRASH (AI layer only)" },
        restore: { type: "array", items: { type: "number" }, description: "Trashed card ids to lift back" },
    },
    required: ["board"],
    additionalProperties: false,
} as const;

export const SCRAPE_BOARD_SCHEMA = {
    type: "object",
    properties: {
        board: { type: "string", description: "Board slug (from boards_list_boards)" },
        section: { type: "string", description: "Journey section name — digest only that frame's members" },
        diff: {
            type: "array",
            items: { type: "string" },
            minItems: 2,
            maxItems: 2,
            description:
                "Exactly two section names — the ITERATION DIFF: members matched pairwise as {pairs:[{a,b}]} " +
                "plus unpaired leftovers. Mutually exclusive with section.",
        },
    },
    required: ["board"],
    additionalProperties: false,
} as const;

export const LIST_SECTIONS_SCHEMA = {
    type: "object",
    properties: { board: { type: "string", description: "Board slug" } },
    required: ["board"],
    additionalProperties: false,
} as const;

export const LIST_PROJECTS_SCHEMA = {
    type: "object",
    properties: {},
    additionalProperties: false,
} as const;

export const UPDATE_SET_SCHEMA = {
    type: "object",
    properties: {
        project: { type: "string" },
        branch: { type: "string" },
        selector: { type: "string", description: "version number | 'latest' | set name | set key" },
        name: { type: "string", description: 'New name slug; "" clears; omit to leave unchanged' },
        title: { type: "string", description: 'New human title; "" clears; omit to leave unchanged' },
    },
    required: ["project", "branch", "selector"],
    additionalProperties: false,
} as const;

export const GET_TEMPLATES_SCHEMA = {
    type: "object",
    properties: {},
    additionalProperties: false,
} as const;
