/**
 * The tracker connector: an outside task per item, reached through the tracker's MCP server (the generic doors
 * `create`, `get`, `update` and `label_task`, for tasks and task links). The server name, the project and the
 * workspace come from the connector's settings, so no tracker is named in code. A parent becomes the outside task's
 * parent; a link becomes a task link.
 */
// lint-rules-ignore: the MCP kit lives in the scripts tool; a connector is tool code that calls an MCP server
import { createHash } from "node:crypto";
import { data, isError, type Kit, text, withKit } from "@app/scripts/lib/kit";
import { retry } from "@genesiscz/utils/async";
import { judgeFacts } from "@genesiscz/utils/work/connectors/three-way";
import type {
    Connector,
    FactChangedOutside,
    PushIntent,
    PushResult,
    RemoteItem,
    SentFacts,
    SyncedFact,
} from "@genesiscz/utils/work/connectors/types";
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

const RATE_LIMITED = /rate_limited|rate limit exceeded|too many requests/i;
const RETRY_AFTER = /retry[-_ ]?after\D{0,4}(\d+(?:\.\d+)?)/i;

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** The pause before the next try of a rate-limited call: the server's Retry-After when it names one, else double. */
export function rateLimitPause(message: string, previousMs: number, limits: { baseMs: number; maxMs: number }): number {
    const named = RETRY_AFTER.exec(message);

    if (named !== null) {
        return Math.min(Math.ceil(Number(named[1]) * 1000), limits.maxMs);
    }

    return Math.min(Math.max(previousMs * 2, limits.baseMs), limits.maxMs);
}

export interface PacingOptions {
    /** False when the caller lost its lease: stop waiting and fail the call. */
    keepAlive?: () => boolean;
    baseMs?: number;
    maxMs?: number;
    maxAttempts?: number;
}

/**
 * A door call that waits out a rate limit and paces the calls after it: each try after a refusal waits the
 * server's Retry-After (else a doubling pause from `baseMs` to `maxMs`), the next calls start with that pause, and
 * each call that passes halves it. A thrown transport error and an `isError` answer count alike; any other error
 * goes back at once.
 */
export function pacedCall(
    call: Kit["call"],
    { keepAlive, baseMs = 1000, maxMs = 30_000, maxAttempts = 8 }: PacingOptions = {}
): Kit["call"] {
    let pause = 0;
    return async (server, tool, args) => {
        if (pause > 0) {
            await Bun.sleep(pause);
        }

        const result = await retry(
            async () => {
                const raw = await call(server, tool, args);

                if (isError(raw) && RATE_LIMITED.test(text(raw))) {
                    throw new Error(text(raw));
                }

                return raw;
            },
            {
                maxAttempts,
                shouldRetry: (error) => RATE_LIMITED.test(messageOf(error)) && keepAlive?.() !== false,
                getDelay: (_attempt, error) => {
                    pause = rateLimitPause(messageOf(error), pause, { baseMs, maxMs });
                    return pause;
                },
            }
        );
        pause = pause >= 2 * baseMs ? Math.floor(pause / 2) : 0;
        return result;
    };
}

/** The patch key of each fact a push writes. */
const PATCH_KEY_OF: Partial<Record<SyncedFact, string>> = {
    state: "status",
    title: "title",
    body: "body",
    type: "type",
    parent: "parentId",
};

/** The facts a patch writes, in the words it writes them. */
export function factsOfPatch(patch: Record<string, unknown>): SentFacts {
    const facts: SentFacts = {};

    for (const [fact, key] of Object.entries(PATCH_KEY_OF) as [SyncedFact, string][]) {
        const value = patch[key];

        if (typeof value === "string" || typeof value === "number") {
            facts[fact] = String(value);
        }
    }

    return facts;
}

/**
 * The same facts as the task holds them. With no base for the body (a pairing from before the check), an untouched
 * render of the fields counts as empty, so the newer render replaces it.
 */
export function outsideFacts(
    task: Record<string, unknown>,
    { base, ours }: { base: SentFacts; ours: SentFacts }
): SentFacts {
    const text = (value: unknown): string | undefined =>
        typeof value === "string" || typeof value === "number" ? String(value) : undefined;
    const body = text(task.body) ?? "";
    const facts: SentFacts = {
        state: text(task.status),
        title: text(task.title),
        body: base.body === undefined && body !== ours.body && isUntouchedRender(body) ? "" : body,
        type: text(task.type),
        parent: text(task.parentId) ?? "",
    };
    return Object.fromEntries(Object.entries(facts).filter(([, value]) => value !== undefined));
}

/** The patch with only the facts to write (its other keys, such as labels, stay). */
function withOnly(patch: Record<string, unknown>, send: readonly SyncedFact[]): Record<string, unknown> {
    const dropped = new Set(
        (Object.entries(PATCH_KEY_OF) as [SyncedFact, string][])
            .filter(([fact]) => !send.includes(fact))
            .map(([, key]) => key)
    );
    return Object.fromEntries(Object.entries(patch).filter(([key]) => !dropped.has(key)));
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
                const call = pacedCall(
                    kit.call.bind(kit),
                    ctx.keepAlive !== undefined ? { keepAlive: ctx.keepAlive } : {}
                );
                const results: PushResult[] = [];

                for (const intent of intents) {
                    let key = intent.pairing?.remoteKey ?? "";

                    // A long wave renews the sync's lease as it goes; without it the pass would drop every answer.
                    if (ctx.keepAlive?.() === false) {
                        results.push({ ok: false, error: "the sync lease was lost; the next pass pushes it" });
                        continue;
                    }

                    try {
                        const bornHere = intent.pairing === null || intent.pairing.born === "local";
                        const types = bornHere ? typeLabels(intent.item.type, settings) : { add: [], remove: [] };
                        const labels = [...intent.labels, ...types.add];
                        let outside: Record<string, unknown> | undefined;
                        const outsideTask = async (): Promise<Record<string, unknown>> => {
                            outside ??= answer(
                                await call(
                                    settings.server,
                                    "get",
                                    scoped(settings, { kind: "task", id: taskId(key), include: ["links"] })
                                ),
                                "get"
                            );
                            return outside;
                        };

                        let sent: SentFacts = {};
                        let changedOutside: FactChangedOutside[] = [];

                        if (key === "") {
                            const patch = patchOf(intent, true, settings);
                            sent = factsOfPatch(patch);
                            const made = answer(
                                await call(
                                    settings.server,
                                    "create",
                                    scoped(settings, { kind: "task", project: settings.project, ...patch, labels })
                                ),
                                "create"
                            );
                            const id = idOf(made);

                            if (id === null) {
                                throw new Error("create: the answer carries no task id");
                            }

                            key = id;
                        } else {
                            // Read the task first: a fact edited outside since the last push is never overwritten.
                            const patch = patchOf(intent, bornHere, settings);
                            const base = intent.pairing?.sent ?? {};
                            const ours = factsOfPatch(patch);
                            const judged = judgeFacts({
                                ours,
                                theirs: outsideFacts(taskOf(await outsideTask()), { base, ours }),
                                base,
                                ...(intent.force !== undefined ? { force: intent.force } : {}),
                            });
                            const update = withOnly(patch, judged.send);
                            sent = judged.sent;
                            changedOutside = judged.changedOutside;

                            if (Object.keys(update).length > 0) {
                                answer(
                                    await call(
                                        settings.server,
                                        "update",
                                        scoped(settings, { kind: "task", id: key, ...update })
                                    ),
                                    "update"
                                );
                            }
                        }

                        if (labels.length > 0 || types.remove.length > 0) {
                            answer(
                                await call(
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
                                    await call(
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

                        results.push({
                            ok: true,
                            remoteKey: key,
                            sent,
                            ...(changedOutside.length > 0 ? { changedOutside } : {}),
                        });
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
                const call = pacedCall(kit.call.bind(kit));
                const remotes: RemoteItem[] = [];

                for (const key of ask.remoteKeys) {
                    const reply = answer(
                        await call(settings.server, "get", scoped(settings, { kind: "task", id: key })),
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
