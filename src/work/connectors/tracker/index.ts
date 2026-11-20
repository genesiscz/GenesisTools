/**
 * The tracker connector: an outside task per item, reached through the tracker's MCP server (the generic doors
 * `create`, `get`, `update` and `label_task`, for tasks and task links). The server name, the project and the
 * workspace come from the connector's settings, so no tracker is named in code. A parent becomes the outside task's
 * parent; a link becomes a task link.
 */
// lint-rules-ignore: the MCP kit lives in the scripts tool; a connector is tool code that calls an MCP server
import { data, isError, text, withKit } from "@app/scripts/lib/kit";
import type { Connector, PushIntent, PushResult, RemoteItem } from "@genesiscz/utils/work/connectors/types";
import type { Item } from "@genesiscz/utils/work/model/item";
import type { ItemState, ItemType, LinkKind } from "@genesiscz/utils/work/model/vocab";
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

const OUTSIDE_TYPES = new Set(["task", "bug", "epic", "todo", "story"]);

function outsideType(type: ItemType): string {
    return OUTSIDE_TYPES.has(type) ? type : "task";
}

function localType(type: unknown): ItemType | undefined {
    return type === "bug" || type === "epic" || type === "task" || type === "todo" ? type : undefined;
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

/** A numeric key is sent as a number, as the task doors expect; any other key as it is. */
function taskId(key: string): number | string {
    return /^\d+$/.test(key) ? Number(key) : key;
}

/** The title as the tracker takes it, and the body that carries the full title when it had to be cut. */
function titleAndBody(item: Item, limit: number): { title: string; body?: string } {
    const chars = Array.from(item.title);
    const body = item.body !== null && item.body !== undefined ? item.body : undefined;

    if (chars.length <= limit) {
        return body !== undefined ? { title: item.title, body } : { title: item.title };
    }

    return {
        title: `${chars.slice(0, limit - 1).join("")}…`,
        body: body !== undefined && body !== "" ? `${item.title}\n\n${body}` : item.title,
    };
}

/** What a push sends: the facts the local side owns. A task born outside keeps its own title, text and parent. */
export function patchOf(intent: PushIntent, bornHere: boolean, settings: TrackerSettings): Record<string, unknown> {
    const { item } = intent;
    const patch: Record<string, unknown> = { status: STATUS_OF[item.state] };

    if (bornHere) {
        Object.assign(patch, titleAndBody(item, settings.titleLimit ?? DEFAULT_TITLE_LIMIT));
        patch.type = outsideType(item.type);

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

                        if (key === "") {
                            const made = answer(
                                await kit.call(
                                    settings.server,
                                    "create",
                                    scoped(settings, {
                                        kind: "task",
                                        project: settings.project,
                                        ...patchOf(intent, true, settings),
                                        labels: intent.labels,
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
                            answer(
                                await kit.call(
                                    settings.server,
                                    "update",
                                    scoped(settings, { kind: "task", id: key, ...patchOf(intent, bornHere, settings) })
                                ),
                                "update"
                            );
                        }

                        if (intent.labels.length > 0) {
                            answer(
                                await kit.call(
                                    settings.server,
                                    "label_task",
                                    scoped(settings, { id: key, add: intent.labels })
                                ),
                                "label_task"
                            );
                        }

                        if (bornHere && intent.links !== undefined && intent.links.length > 0) {
                            const existing = linksOf(
                                answer(
                                    await kit.call(
                                        settings.server,
                                        "get",
                                        scoped(settings, { kind: "task", id: taskId(key), include: ["links"] })
                                    ),
                                    "get links"
                                )
                            );

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
                    const task = (reply.task !== null && typeof reply.task === "object" ? reply.task : reply) as Record<
                        string,
                        unknown
                    >;
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
                    remotes.push({
                        remoteKey: key,
                        ...(typeof task.title === "string" ? { title: task.title } : {}),
                        ...(typeof task.body === "string" ? { body: task.body } : {}),
                        ...(localType(task.type) !== undefined ? { type: localType(task.type) } : {}),
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
