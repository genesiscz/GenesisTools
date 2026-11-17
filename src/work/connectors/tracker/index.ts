/**
 * The tracker connector: an outside task per item, reached through the tracker's MCP server (the generic task doors
 * `create`, `get`, `update` and `label_task`). The server name, the project and the workspace come from the
 * connector's settings, so no tracker is named in code.
 */
// lint-rules-ignore: the MCP kit lives in the scripts tool; a connector is tool code that calls an MCP server
import { data, isError, text, withKit } from "@app/scripts/lib/kit";
import type { Connector, PushIntent, PushResult, RemoteItem } from "@genesiscz/utils/work/connectors/types";
import type { Item } from "@genesiscz/utils/work/model/item";
import type { ItemState, ItemType } from "@genesiscz/utils/work/model/vocab";
import { z } from "zod";

export const trackerSettings = z.object({
    /** The MCP server's name in the registry. */
    server: z.string().min(1),
    /** The project slug a new outside task goes into. */
    project: z.string().min(1),
    /** The workspace slug, when the server does not bind one by itself. */
    workspace: z.string().optional(),
});

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

    if (parsed === undefined || typeof parsed !== "object") {
        throw new Error(`${what}: no JSON in the answer (${text(raw).slice(0, 200)})`);
    }

    return parsed;
}

function idOf(reply: Record<string, unknown>): string | null {
    const task = reply.task;
    const id = reply.id ?? (task !== null && typeof task === "object" ? (task as { id?: unknown }).id : undefined);
    return typeof id === "number" || typeof id === "string" ? String(id) : null;
}

function scoped(settings: TrackerSettings, args: Record<string, unknown>): Record<string, unknown> {
    return settings.workspace !== undefined ? { ...args, workspace: settings.workspace } : args;
}

/** What a push sends: the facts the local side owns. A task born outside keeps its own title and text. */
function patchOf(item: Item, bornHere: boolean): Record<string, unknown> {
    const patch: Record<string, unknown> = { status: STATUS_OF[item.state] };

    if (bornHere) {
        patch.title = item.title;
        patch.type = outsideType(item.type);

        if (item.body !== null && item.body !== undefined) {
            patch.body = item.body;
        }
    }

    return patch;
}

export const trackerConnector: Connector<unknown> = {
    id: "tracker",
    settings: trackerSettings,
    can: { create: true, pull: true, labels: true, comments: false, parents: false },

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
                    try {
                        let key = intent.pairing?.remoteKey ?? "";
                        const bornHere = intent.pairing === null || intent.pairing.born === "local";

                        if (key === "") {
                            const made = answer(
                                await kit.call(
                                    settings.server,
                                    "create",
                                    scoped(settings, {
                                        kind: "task",
                                        project: settings.project,
                                        ...patchOf(intent.item, true),
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
                                    scoped(settings, { kind: "task", id: key, ...patchOf(intent.item, bornHere) })
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

                        results.push({ ok: true, remoteKey: key });
                    } catch (error) {
                        results.push({ ok: false, error: error instanceof Error ? error.message : String(error) });
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
                        ? task.labels.map((l) => (typeof l === "string" ? l : String((l as { name?: unknown }).name)))
                        : undefined;
                    remotes.push({
                        remoteKey: key,
                        ...(typeof task.title === "string" ? { title: task.title } : {}),
                        ...(typeof task.body === "string" ? { body: task.body } : {}),
                        ...(localType(task.type) !== undefined ? { type: localType(task.type) } : {}),
                        ...(status !== undefined && STATE_OF[status] !== undefined ? { state: STATE_OF[status] } : {}),
                        ...(labels !== undefined ? { labels } : {}),
                    });
                }

                return remotes;
            },
            { servers: [settings.server], timeoutMs: 60_000 }
        );
    },
};
