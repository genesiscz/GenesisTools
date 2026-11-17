/**
 * The one method table of the work store. The CLI (`tools work`), the MCP tools `work_*`, the REPL global `work` and
 * the `work` area of the actions registry are all made from it. Params stay flat, so each key is one CLI flag.
 */
import { defineApi, defineMethod } from "@genesiscz/utils/api-descriptor";
import { z } from "zod";
import { ITEM_STATES, ITEM_TYPES, LINK_KINDS, LOG_RESULTS, SEVERITIES } from "./model/vocab";

const ref = z.string().min(1).describe("an id (w_…, h_…) or <handoff>:<slot>");
const refs = z.array(z.string().min(1)).min(1).describe("ids or <handoff>:<slot>, comma-separated on the CLI");
const type = z.enum(ITEM_TYPES);
const severity = z.enum(SEVERITIES);
const reply = "Reply<T>: { v, verb, ok, data, diagnostics, next, receipt?, dryRun? }";

const fieldParams = {
    where: z.string().optional().describe("where you saw it, path:line"),
    why: z.string().optional().describe("why it is wrong or matters"),
    userSees: z.string().optional().describe("what a user sees because of it"),
    cost: z.string().optional().describe("what it costs to do now; only when judged"),
};

export const workMethods = {
    list: defineMethod({
        name: "list",
        params: z.object({
            project: z.string().optional().describe("the main checkout folder name"),
            under: z.string().optional().describe("members of a handoff, or children of an item"),
            spottedIn: z.string().optional().describe("items spotted during this handoff or one of its tasks"),
            state: z.array(z.enum(ITEM_STATES)).optional(),
            type: z.array(type).optional(),
            tag: z.string().optional(),
            severity: z.array(severity).optional(),
            worker: z.string().optional().describe("the last worker: me, or a session id"),
            fields: z
                .array(z.string())
                .optional()
                .describe("columns: ref,state,type,severity,worker,title,project,slot"),
            limit: z.number().int().positive().max(5000).optional(),
        }),
        result: z.unknown(),
        resultName: `${reply}, data: { ref, state, type, severity?, worker?, title, project, slot? }[]`,
        effect: "read",
        doc: "List items, one short row each, no bodies.",
    }),
    show: defineMethod({
        name: "show",
        params: z.object({ ref, section: z.enum(["all", "body", "log", "refs", "context"]).optional() }),
        result: z.unknown(),
        resultName: `${reply}, data: { item, refs: { out, in }, pointers, log, members? }`,
        effect: "read",
        doc: "One item with its references, pointers and work log.",
    }),
    tree: defineMethod({
        name: "tree",
        params: z.object({
            project: z.string().optional(),
            all: z.boolean().optional().describe("also finished containers"),
        }),
        result: z.unknown(),
        resultName: `${reply}, data: { containers: { ref, type, state, title, open, total, members }[], spotted: number }`,
        effect: "read",
        doc: "The open handoffs and epics of a project with their members, and the count of spotted items.",
    }),
    triage: defineMethod({
        name: "triage",
        params: z.object({ project: z.string().optional() }),
        result: z.unknown(),
        resultName: `${reply}, data: { ref, group, type, title, where?, why?, userSees?, spottedIn?, spottedBy?, next }[]`,
        effect: "read",
        doc: "The dangling check: what nobody owns, in four groups, with next actions per row.",
    }),
    context: defineMethod({
        name: "context",
        params: z.object({ network: z.boolean().optional().describe("ask the forge, not the local cache") }),
        result: z.unknown(),
        resultName: `${reply}, data: { current: Record<path, fact>, candidates: fact[] }`,
        effect: "read",
        doc: "What this session works on, with how each fact was found (given, read, inferred).",
    }),
    config: defineMethod({
        name: "config",
        params: z.object({ project: z.string().optional(), type: z.array(type).optional() }),
        result: z.unknown(),
        resultName: `${reply}, data: { project, rows: { type, fields, writes }[] }`,
        effect: "read",
        doc: "The effective rules of a project; each value names the layer that set it.",
    }),
    spot: defineMethod({
        name: "spot",
        params: z.object({
            title: z.string().min(1),
            type,
            ...fieldParams,
            severity: severity.optional().describe("only when you judged it"),
            existedBefore: z.boolean().optional(),
            production: z.boolean().optional().describe("a live user can hit it"),
            during: z.string().optional().describe("the task or handoff you worked on; default: your live claim"),
        }),
        result: z.unknown(),
        resultName: `${reply}, data: { items: Item[] }`,
        effect: "reversible",
        doc: "File a thing you saw and did not fix; it pairs with your live claim and goes to the inbox.",
    }),
    add: defineMethod({
        name: "add",
        params: z.object({
            title: z.string().min(1),
            type,
            parent: z.string().optional(),
            under: z.string().optional().describe("add it as a member of this handoff"),
            for: z.string().optional(),
            body: z.string().optional(),
            acceptance: z.string().optional(),
        }),
        result: z.unknown(),
        resultName: `${reply}, data: { items: Item[] }`,
        effect: "reversible",
        doc: "Add a work item; under a handoff it becomes a new task of it.",
    }),
    edit: defineMethod({
        name: "edit",
        params: z.object({
            ref,
            type: type.optional(),
            severity: severity.optional(),
            parent: z.string().optional(),
            for: z.string().optional(),
            title: z.string().optional(),
            ...fieldParams,
            during: z.string().optional().describe("pair a spotted item with the task it was seen in"),
        }),
        result: z.unknown(),
        resultName: `${reply}, data: { items: Item[] }`,
        effect: "reversible",
        doc: "Change the type, severity, parent, owner, title or fields of an item.",
    }),
    link: defineMethod({
        name: "link",
        params: z.object({ ref, kind: z.enum(LINK_KINDS), to: ref }),
        result: z.unknown(),
        resultName: `${reply}, data: { items: Item[] }`,
        effect: "reversible",
        doc: "Point one item at another.",
    }),
    unlink: defineMethod({
        name: "unlink",
        params: z.object({ ref, kind: z.enum(LINK_KINDS), to: ref }),
        result: z.unknown(),
        resultName: `${reply}, data: { items: Item[] }`,
        effect: "reversible",
        doc: "Remove a reference.",
    }),
    accept: defineMethod({
        name: "accept",
        params: z.object({ refs, type: type.optional(), severity: severity.optional() }),
        result: z.unknown(),
        resultName: `${reply}, data: { items: Item[] }`,
        effect: "reversible",
        doc: "Accept spotted items: spotted becomes open.",
    }),
    claim: defineMethod({
        name: "claim",
        params: z.object({ ref }),
        result: z.unknown(),
        resultName: `${reply}, data: { items: Item[] }`,
        effect: "reversible",
        doc: "Take an item; a member of a handoff claims the handoff.",
    }),
    release: defineMethod({
        name: "release",
        params: z.object({ ref }),
        result: z.unknown(),
        resultName: `${reply}, data: { items: Item[] }`,
        effect: "reversible",
        doc: "Give an item back: active becomes open.",
    }),
    finish: defineMethod({
        name: "finish",
        params: z.object({
            ref,
            proof: z.string().min(1).describe("the command, where it ran, the commit"),
            commits: z.array(z.string()).optional(),
        }),
        result: z.unknown(),
        resultName: `${reply}, data: { items: Item[] }`,
        effect: "reversible",
        doc: "Finish an item with its proof; a task of a handoff is ticked there too.",
    }),
    drop: defineMethod({
        name: "drop",
        params: z.object({ refs, why: z.string().min(1) }),
        result: z.unknown(),
        resultName: `${reply}, data: { items: Item[] }`,
        effect: "reversible",
        doc: "Drop items nobody will do, with the reason.",
    }),
    comment: defineMethod({
        name: "comment",
        params: z.object({ ref, text: z.string().min(1) }),
        result: z.unknown(),
        resultName: `${reply}, data: { items: Item[] }`,
        effect: "reversible",
        doc: "Add a comment to an item.",
    }),
    log: defineMethod({
        name: "log",
        params: z.object({
            ref,
            result: z.enum(LOG_RESULTS),
            note: z.string().optional(),
            measured: z.string().optional().describe('"<number, unit, target>"'),
        }),
        result: z.unknown(),
        resultName: `${reply}, data: { items: Item[] }`,
        effect: "reversible",
        doc: "Record one attempt on an item: fixed, partly, failed, or a limit with its number.",
    }),
    reopen: defineMethod({
        name: "reopen",
        params: z.object({
            ref,
            why: z.string().min(1).describe("what is still wrong, with the evidence"),
            deliver: z.enum(["auto", "never"]).optional(),
        }),
        result: z.unknown(),
        resultName: `${reply}, data: { item, worker, place, receipt: { outcome: delivered|queued|nobody-alive|unknown }, key }`,
        effect: "reversible",
        reaches: ["user"],
        doc: "Reopen a done or dropped item and tell its worker, with a delivery receipt.",
    }),
    pair: defineMethod({
        name: "pair",
        params: z.object({
            ref,
            connector: z.string().min(1).describe("a connector id: reminders, tracker"),
            key: z.string().min(1).describe("the outside item's key"),
        }),
        result: z.unknown(),
        resultName: `${reply}, data: { pairing, push: { pushed, held, failed } }`,
        effect: "reversible",
        reaches: ["user"],
        doc: "Pair a local item with an outside one; the label is pushed at once. Nothing moves.",
    }),
    unpair: defineMethod({
        name: "unpair",
        params: z.object({ ref, connector: z.string().min(1) }),
        result: z.unknown(),
        resultName: `${reply}, data: { removed }`,
        effect: "reversible",
        doc: "Remove the pairing of an item with one connector; the outside item stays as it is.",
    }),
    pull: defineMethod({
        name: "pull",
        params: z.object({
            connector: z.string().min(1),
            keys: z.array(z.string().min(1)).min(1).describe("outside keys, comma-separated on the CLI"),
            project: z.string().optional().describe("the project a new item goes into; default the current one"),
        }),
        result: z.unknown(),
        resultName: `${reply}, data: { made, updated, drift }`,
        effect: "reversible",
        doc: "Read outside items: an unknown one becomes a local item born outside, a known one brings its facts.",
    }),
    sync: defineMethod({
        name: "sync",
        params: z.object({
            release: z.string().optional().describe("push this item's held change now"),
        }),
        result: z.unknown(),
        resultName: `${reply}, data: { pushed, held, failed, skipped?, cursor }`,
        effect: "reversible",
        reaches: ["user"],
        doc: "One pass of the sync consumer under its lease, or --release <ref> for a held change.",
    }),
    handoff: defineMethod({
        name: "handoff",
        params: z.object({
            title: z.string().min(1),
            from: refs,
            target: z.string().optional().describe("claude|codex|grok|copilot"),
            body: z.string().optional(),
        }),
        result: z.unknown(),
        resultName: `${reply}, data: { items: Item[], handoff }`,
        effect: "reversible",
        doc: "Make a handoff from items: one write accepts them and adds them as its tasks.",
    }),
    batch: defineMethod({
        name: "batch",
        params: z.object({
            calls: z.array(z.object({ method: z.string(), params: z.record(z.string(), z.unknown()) })).min(1),
        }),
        result: z.unknown(),
        resultName: `${reply}, data: Reply[] (one per call, in order; it stops at the first failure)`,
        effect: "reversible",
        doc: "Run several writes in order; it stops at the first one that fails.",
    }),
} as const;

export type WorkMethodName = keyof typeof workMethods;
export type WorkParams<M extends WorkMethodName> = z.output<(typeof workMethods)[M]["params"]>;

export const workApi = defineApi({
    id: "work",
    global: "work",
    title: "Work items",
    summary: "One store of handoffs, tasks, spotted items, epics and todos, with references between them.",
    methods: Object.values(workMethods),
    notes: [
        "A ref is an id (w_…, h_…) or <handoff>:<slot>.",
        "Every write takes a request id (a repeat answers the stored reply) and a dry run.",
        "While shadow mode lasts, a tick, claim or text of a handoff task goes through the old handoff store.",
    ],
});

/** The words a CLI takes as arguments, in order; every other key is a flag. */
export const WORK_CLI_POSITIONAL: Partial<Record<WorkMethodName, readonly string[]>> = {
    show: ["ref"],
    spot: ["title"],
    add: ["title"],
    edit: ["ref"],
    link: ["ref", "kind", "to"],
    unlink: ["ref", "kind", "to"],
    accept: ["refs"],
    claim: ["ref"],
    release: ["ref"],
    finish: ["ref"],
    drop: ["refs"],
    comment: ["ref", "text"],
    log: ["ref"],
    reopen: ["ref"],
    handoff: ["title"],
    pair: ["ref", "connector", "key"],
    unpair: ["ref", "connector"],
    pull: ["connector", "keys"],
};
