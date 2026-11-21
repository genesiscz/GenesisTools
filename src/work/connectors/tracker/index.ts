/**
 * The tracker connector: an outside task per item, reached through the tracker's MCP server (the generic doors
 * `create`, `get`, `update` and `label_task`, for tasks and task links). The server name, the project and the
 * workspace come from the connector's settings, so no tracker is named in code. A parent becomes the outside task's
 * parent; a link becomes a task link.
 */
// lint-rules-ignore: the MCP kit lives in the scripts tool; a connector is tool code that calls an MCP server
import { createHash } from "node:crypto";
import { data, isError, text, withKit } from "@app/scripts/lib/kit";
import type { Connector, PushIntent, PushResult, RemoteItem } from "@genesiscz/utils/work/connectors/types";
import type { Item, ItemFields } from "@genesiscz/utils/work/model/item";
import { ITEM_TYPES, type ItemState, type ItemType, type LinkKind } from "@genesiscz/utils/work/model/vocab";
import { z } from "zod";

export const trackerSettings = z.object({
    /** The MCP server's name in the registry. */
    server: z.string().min(1),
    /** The project slug a new outside task goes into. */
    project: z.string().min(1),
    /** The workspace slug, when the server does not bind one by itself. */
    workspace: z.string().optional(),
    /** The longest title the tracker takes; a longer one is cut there, and the full title opens the body. */
    titleLimit: z.number().int().positive().optional(),
    /** The outside type of each local type; a type left out takes the default of DEFAULT_TYPES. */
    types: z.partialRecord(z.enum(ITEM_TYPES), z.string().min(1)).optional(),
    /**
     * The label that keeps the local type on a task whose outside type is another (`{type}` is the local type), so a
     * pull gives the local type back. An empty string sends no label.
     */
    typeLabel: z.string().optional(),
});

/** The title limit of the tracker this connector was first written for. */
const DEFAULT_TITLE_LIMIT = 500;

export type TrackerSettings = z.infer<typeof trackerSettings>;

const STATUS_OF: Record<ItemState, string> = {
    spotted: "backlog",
    open: "todo",
    active: "in_progress",
    done: "done",
    dropped: "cancelled",
    reopened: "todo",
};

const STATE_OF: Record<string, ItemState> = {
    backlog: "open",
    todo: "open",
    in_progress: "active",
    in_review: "active",
    done: "done",
    cancelled: "dropped",
};

/** The outside type of each local type in the tracker this connector was first written for. */
const DEFAULT_TYPES: Record<ItemType, string> = {
    epic: "epic",
    handoff: "task",
    feature: "story",
    bug: "bug",
    incident: "bug",
    task: "task",
    test: "qa",
    cleanup: "task",
    check: "qa",
    idea: "task",
    risk: "watch",
    limit: "task",
    todo: "todo",
};

const DEFAULT_TYPE_LABEL = "type:{type}";

export function outsideType(type: ItemType, settings: TrackerSettings): string {
    return settings.types?.[type] ?? DEFAULT_TYPES[type];
}

function typeLabelOf(type: ItemType, settings: TrackerSettings): string | undefined {
    const template = settings.typeLabel ?? DEFAULT_TYPE_LABEL;
    return template === "" ? undefined : template.replaceAll("{type}", type);
}

/** The type labels a push adds and removes: the local type's label when the outside type differs, no other. */
export function typeLabels(type: ItemType, settings: TrackerSettings): { add: string[]; remove: string[] } {
    const wanted = outsideType(type, settings) !== type ? typeLabelOf(type, settings) : undefined;
    const remove = ITEM_TYPES.map((other) => typeLabelOf(other, settings)).filter(
        (label): label is string => label !== undefined && label !== wanted
    );
    return { add: wanted !== undefined ? [wanted] : [], remove };
}

/**
 * The local type of an outside task: the type label when it still fits the outside type, else the one local type
 * that maps to it (the type of the same name first). An outside type no local type maps to gives nothing.
 */
export function localTypeOf(
    remote: unknown,
    labels: readonly string[],
    settings: TrackerSettings
): ItemType | undefined {
    if (typeof remote !== "string") {
        return undefined;
    }

    const labelled = ITEM_TYPES.find(
        (type) => labels.includes(typeLabelOf(type, settings) ?? "") && outsideType(type, settings) === remote
    );

    if (labelled !== undefined) {
        return labelled;
    }

    const candidates = ITEM_TYPES.filter((type) => outsideType(type, settings) === remote);
    const same = candidates.find((type) => type === remote);
    return same ?? (candidates.length === 1 ? candidates[0] : undefined);
}

/** The fields a body is made of, in the order a reader wants them. */
const BODY_FIELDS: readonly { field: keyof ItemFields; label: string }[] = [
    { field: "where", label: "Where" },
    { field: "why", label: "Why" },
    { field: "userSees", label: "What a user sees" },
    { field: "cost", label: "Cost" },
    { field: "measured", label: "Measured" },
];

const RENDER_MARK = /\n*<!-- tools work: from the item's fields, ([0-9a-f]{12}) -->\s*$/;

function hashOf(textToHash: string): string {
    return createHash("sha256").update(textToHash.trim()).digest("hex").slice(0, 12);
}

/** The body of an item that has none: its fields, one paragraph each. Nothing when no field is filled. */
function fieldsText(item: Item): string | undefined {
    const paragraphs = BODY_FIELDS.flatMap(({ field, label }) => {
        const value = item.fields[field];
        return typeof value === "string" && value.trim() !== "" ? [`**${label}:** ${value.trim()}`] : [];
    });
    return paragraphs.length > 0 ? paragraphs.join("\n\n") : undefined;
}

/** A body made from the fields, closed by a mark with the hash of the text, so a later push knows it is untouched. */
function markRender(body: string): string {
    return `${body}\n\n<!-- tools work: from the item's fields, ${hashOf(body)} -->`;
}

/** An update leaves the outside body alone when it already is this render, or someone wrote it by hand. */
export function keepsOutsideBody(render: string, theirs: string): boolean {
    return theirs === render || (theirs !== "" && !isUntouchedRender(theirs));
}

/** True for a body this connector rendered from the fields and nobody has edited since. */
export function isUntouchedRender(body: string): boolean {
    const mark = RENDER_MARK.exec(body);
    return mark !== null && hashOf(body.slice(0, mark.index)) === mark[1];
}

/** The answer of a door: its JSON, or an error with the server's own text. */
function answer(raw: unknown, what: string): Record<string, unknown> {
    if (isError(raw)) {
        throw new Error(`${what}: ${text(raw).slice(0, 300)}`);
    }

    const parsed = data<Record<string, unknown>>(raw);

    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`${what}: no JSON in the answer (${text(raw).slice(0, 200)})`);
    }

    return parsed;
}

function idOf(reply: Record<string, unknown>): string | null {
    const task = reply.task;
    const id = reply.id ?? (task !== null && typeof task === "object" ? (task as { id?: unknown }).id : undefined);
    return typeof id === "number" || (typeof id === "string" && id.trim() !== "") ? String(id) : null;
}

function scoped(settings: TrackerSettings, args: Record<string, unknown>): Record<string, unknown> {
    return settings.workspace !== undefined ? { ...args, workspace: settings.workspace } : args;
}

/** The task of a door's answer: under `task`, or the answer itself. */
function taskOf(reply: Record<string, unknown>): Record<string, unknown> {
    const task = reply.task;
    return task !== null && typeof task === "object" && !Array.isArray(task)
        ? (task as Record<string, unknown>)
        : reply;
}

function bodyOf(task: Record<string, unknown>): string {
    return typeof task.body === "string" ? task.body : "";
}

/** A numeric key is sent as a number, as the task doors expect; any other key as it is. */
function taskId(key: string): number | string {
    return /^\d+$/.test(key) ? Number(key) : key;
}

/**
 * The title as the tracker takes it, and the body: the item's own, or its fields when it has none (marked as a
 * render). A title over the limit is cut, and the full title opens the body.
 */
function titleAndBody(item: Item, limit: number): { title: string; body?: string } {
    const chars = Array.from(item.title);
    const own = item.body !== null && item.body !== undefined && item.body !== "" ? item.body : undefined;
    const rendered = own === undefined ? fieldsText(item) : undefined;
    const cut = chars.length > limit;
    const title = cut ? `${chars.slice(0, limit - 1).join("")}…` : item.title;
    const text = own ?? rendered;
    const full = cut ? (text !== undefined ? `${item.title}\n\n${text}` : item.title) : text;

    if (full === undefined) {
        return item.body === "" ? { title, body: "" } : { title };
    }

    return { title, body: rendered !== undefined ? markRender(full) : full };
}

/** What a push sends: the facts the local side owns. A task born outside keeps its own title, text and parent. */
export function patchOf(intent: PushIntent, bornHere: boolean, settings: TrackerSettings): Record<string, unknown> {
    const { item } = intent;
    const patch: Record<string, unknown> = { status: STATUS_OF[item.state] };

    if (bornHere) {
        Object.assign(patch, titleAndBody(item, settings.titleLimit ?? DEFAULT_TITLE_LIMIT));
        patch.type = outsideType(item.type, settings);

        if (intent.parentKey !== undefined) {
            patch.parentId = taskId(intent.parentKey);
        }
    }

    return patch;
}

/** The task link relation of each local link kind; the kinds the tracker has no name for go as a custom label. */
const RELATION_OF: Record<LinkKind, { rel: string; label?: string }> = {
    related: { rel: "relates" },
    blocks: { rel: "blocks" },
    "duplicate-of": { rel: "duplicates" },
    "recheck-of": { rel: "custom", label: "recheck of" },
    "follow-up-of": { rel: "custom", label: "follow-up of" },
};

interface OutsideLink {
    rel: string;
    label?: string;
    direction?: string;
    target: string;
}

export function linksOf(reply: Record<string, unknown>): OutsideLink[] {
    const task =
        reply.task !== null && typeof reply.task === "object" ? (reply.task as Record<string, unknown>) : reply;
    const raw = Array.isArray(task.links) ? task.links : Array.isArray(reply.links) ? reply.links : [];
    return raw.flatMap((link: unknown) => {
        if (link === null || typeof link !== "object") {
            return [];
        }

        const row = link as Record<string, unknown>;
        const to = row.task !== null && typeof row.task === "object" ? (row.task as { id?: unknown }).id : row.toTaskId;

        if (typeof row.rel !== "string" || (typeof to !== "number" && typeof to !== "string")) {
            return [];
        }

        return [
            {
                rel: row.rel,
                target: String(to),
                ...(typeof row.label === "string" ? { label: row.label } : {}),
                ...(typeof row.direction === "string" ? { direction: row.direction } : {}),
            },
        ];
    });
}

/** "relates" holds both ways; every other relation is read from the side that made it. */
export function hasLink(
    existing: readonly OutsideLink[],
    wanted: { rel: string; label?: string; target: string }
): boolean {
    return existing.some(
        (link) =>
            link.rel === wanted.rel &&
            link.target === wanted.target &&
            (wanted.rel === "relates" || link.direction === undefined || link.direction === "out") &&
            (wanted.label === undefined || link.label === wanted.label)
    );
}

export const trackerConnector: Connector<unknown> = {
    id: "tracker",
    settings: trackerSettings,
    can: { create: true, pull: true, labels: true, comments: false, parents: true, links: true },

    stateMatches: (remote, local) => remote.status === STATUS_OF[local],

    async status(ctx) {
        const parsed = trackerSettings.safeParse(ctx.settings);

        if (!parsed.success) {
            return { ok: false, detail: `settings: ${parsed.error.issues[0]?.message ?? "invalid"}` };
        }

        return { ok: true, detail: `server ${parsed.data.server}, project ${parsed.data.project}` };
    },

    async push(intents: readonly PushIntent[], ctx): Promise<PushResult[]> {
        const settings = trackerSettings.parse(ctx.settings);
        return withKit(
            async (kit) => {
                const results: PushResult[] = [];

                for (const intent of intents) {
                    let key = intent.pairing?.remoteKey ?? "";

                    try {
                        const bornHere = intent.pairing === null || intent.pairing.born === "local";
                        const types = bornHere ? typeLabels(intent.item.type, settings) : { add: [], remove: [] };
                        const labels = [...intent.labels, ...types.add];
                        let outside: Record<string, unknown> | undefined;
                        const outsideTask = async (): Promise<Record<string, unknown>> => {
                            outside ??= answer(
                                await kit.call(
                                    settings.server,
                                    "get",
                                    scoped(settings, { kind: "task", id: taskId(key), include: ["links"] })
                                ),
                                "get"
                            );
                            return outside;
                        };

                        if (key === "") {
                            const made = answer(
                                await kit.call(
                                    settings.server,
                                    "create",
                                    scoped(settings, {
                                        kind: "task",
                                        project: settings.project,
                                        ...patchOf(intent, true, settings),
                                        labels,
                                    })
                                ),
                                "create"
                            );
                            const id = idOf(made);

                            if (id === null) {
                                throw new Error("create: the answer carries no task id");
                            }

                            key = id;
                        } else {
                            const patch = patchOf(intent, bornHere, settings);

                            // A body rendered from the fields replaces only an empty outside body or an earlier
                            // render nobody edited; a body written by hand outside stays.
                            if (typeof patch.body === "string" && isUntouchedRender(patch.body)) {
                                if (keepsOutsideBody(patch.body, bodyOf(taskOf(await outsideTask())))) {
                                    delete patch.body;
                                }
                            }

                            answer(
                                await kit.call(
                                    settings.server,
                                    "update",
                                    scoped(settings, { kind: "task", id: key, ...patch })
                                ),
                                "update"
                            );
                        }

                        if (labels.length > 0 || types.remove.length > 0) {
                            answer(
                                await kit.call(
                                    settings.server,
                                    "label_task",
                                    scoped(settings, {
                                        id: key,
                                        add: labels,
                                        ...(types.remove.length > 0 ? { remove: types.remove } : {}),
                                    })
                                ),
                                "label_task"
                            );
                        }

                        if (bornHere && intent.links !== undefined && intent.links.length > 0) {
                            const existing = linksOf(await outsideTask());

                            for (const link of intent.links) {
                                const wanted = { ...RELATION_OF[link.kind], target: link.remoteKey };

                                if (link.remoteKey === key || hasLink(existing, wanted)) {
                                    continue;
                                }

                                answer(
                                    await kit.call(
                                        settings.server,
                                        "create",
                                        scoped(settings, {
                                            kind: "task_link",
                                            id: taskId(key),
                                            toTaskId: taskId(link.remoteKey),
                                            rel: wanted.rel,
                                            ...(wanted.label !== undefined ? { label: wanted.label } : {}),
                                        })
                                    ),
                                    "create task_link"
                                );
                                existing.push({ ...wanted, direction: "out" });
                            }
                        }

                        results.push({ ok: true, remoteKey: key });
                    } catch (error) {
                        results.push({
                            ok: false,
                            error: error instanceof Error ? error.message : String(error),
                            ...(key !== "" ? { remoteKey: key } : {}),
                        });
                    }
                }

                return results;
            },
            { servers: [settings.server], timeoutMs: 60_000 }
        );
    },

    async pull(ask, ctx): Promise<RemoteItem[]> {
        const settings = trackerSettings.parse(ctx.settings);
        return withKit(
            async (kit) => {
                const remotes: RemoteItem[] = [];

                for (const key of ask.remoteKeys) {
                    const reply = answer(
                        await kit.call(settings.server, "get", scoped(settings, { kind: "task", id: key })),
                        `get ${key}`
                    );
                    const task = taskOf(reply);
                    const status = typeof task.status === "string" ? task.status : undefined;
                    const labels = Array.isArray(task.labels)
                        ? task.labels.flatMap((label: unknown) => {
                              if (typeof label === "string") {
                                  return [label];
                              }

                              if (
                                  typeof label === "object" &&
                                  label !== null &&
                                  "name" in label &&
                                  typeof label.name === "string"
                              ) {
                                  return [label.name];
                              }

                              return [];
                          })
                        : undefined;
                    const type = localTypeOf(task.type, labels ?? [], settings);
                    remotes.push({
                        remoteKey: key,
                        ...(typeof task.title === "string" ? { title: task.title } : {}),
                        // An untouched render of the fields is the item's own body as this side sent it, not a change.
                        ...(typeof task.body === "string" && !isUntouchedRender(task.body) ? { body: task.body } : {}),
                        ...(type !== undefined ? { type } : {}),
                        ...(status !== undefined && Object.hasOwn(STATE_OF, status) ? { state: STATE_OF[status] } : {}),
                        ...(status !== undefined ? { status } : {}),
                        ...(labels !== undefined ? { labels } : {}),
                    });
                }

                return remotes;
            },
            { servers: [settings.server], timeoutMs: 60_000 }
        );
    },
};
