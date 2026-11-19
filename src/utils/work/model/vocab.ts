/**
 * One list per vocabulary of the work store. The zod enums, the CLI help and the MCP enums derive from these lists,
 * so a new value is one edit here.
 */

export const ITEM_TYPES = [
    "epic",
    "handoff",
    "feature",
    "bug",
    "incident",
    "task",
    "test",
    "cleanup",
    "check",
    "idea",
    "risk",
    "limit",
    "todo",
] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export const ITEM_STATES = ["spotted", "open", "active", "done", "dropped", "reopened"] as const;
export type ItemState = (typeof ITEM_STATES)[number];

/** Absent on an item means "not judged". Never invent one. */
export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** A reference is stored once and listed from both items. */
export const REF_KINDS = [
    "parent",
    "member",
    "related",
    "duplicate-of",
    "recheck-of",
    "follow-up-of",
    "blocks",
    "spotted-in",
] as const;
export type RefKind = (typeof REF_KINDS)[number];

/** The reference kinds a caller links by hand; `parent`, `member` and `spotted-in` have their own commands. */
export const LINK_KINDS = ["related", "duplicate-of", "recheck-of", "follow-up-of", "blocks"] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

export const VERBS = ["accept", "claim", "release", "finish", "drop", "reopen"] as const;
export type Verb = (typeof VERBS)[number];

export const ROLES = ["worker", "poster", "lead", "owner"] as const;
export type Role = (typeof ROLES)[number];

/** epic, handoff · feature … check · idea, risk, limit · todo */
export type ItemLevel = "container" | "work" | "note" | "personal";

const LEVEL_OF: Record<ItemType, ItemLevel> = {
    epic: "container",
    handoff: "container",
    feature: "work",
    bug: "work",
    incident: "work",
    task: "work",
    test: "work",
    cleanup: "work",
    check: "work",
    idea: "note",
    risk: "note",
    limit: "note",
    todo: "personal",
};

export function levelOf(type: ItemType): ItemLevel {
    return LEVEL_OF[type];
}

/** The states in which an item still waits for work. */
export const OPEN_STATES: readonly ItemState[] = ["spotted", "open", "active", "reopened"];

export function isOpenState(state: ItemState): boolean {
    return OPEN_STATES.includes(state);
}

/** The results of one attempt that `tools work log` records. */
export const LOG_RESULTS = ["fixed", "partly", "failed", "limit"] as const;
export type LogResult = (typeof LOG_RESULTS)[number];

export function isOneOf<T extends string>(list: readonly T[], value: string): value is T {
    return (list as readonly string[]).includes(value);
}
