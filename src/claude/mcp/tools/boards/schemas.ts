// Hand-written JSON Schemas for the 11 boards_* MCP tools, following
// QUESTION_ANSWER_INPUT_SCHEMA's shape (type: object, properties, required,
// additionalProperties: false). All eleven live here so descriptions stay reviewable
// in one file; tool descriptions themselves are registered alongside handlers in
// server.ts.

export const LIST_BOARDS_SCHEMA = {
    type: "object",
    properties: { project: { type: "string", description: "Filter by project name" } },
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
    additionalProperties: false,
} as const;
