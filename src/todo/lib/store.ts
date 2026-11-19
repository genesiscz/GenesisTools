/**
 * `tools todo` on the work store (D11: one store). A todo is an item of type `todo`: its title, text, state, severity,
 * tags and reminders are columns of the item, and the fields only a todo has (attachments, links, the git context,
 * the sync ids) ride in one pointer `todo:<id>`. The `todos.json` files are imported one time and stay as an archive;
 * a file that is newer than the import (an old checkout wrote it) is imported again by the same key.
 */
import type { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { whoIsCallingHere } from "@genesiscz/utils/agent/caller-identity";
import { gitCommonRoot } from "@genesiscz/utils/agent/identity";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { withFileLock } from "@genesiscz/utils/storage/file-lock";
import { pairItem } from "@genesiscz/utils/work/connectors/sync";
import type { NewChange } from "@genesiscz/utils/work/model/change";
import { type Actor, asItemId, type Item, type ItemFields } from "@genesiscz/utils/work/model/item";
import type { ItemPatch } from "@genesiscz/utils/work/model/payloads";
import type { ItemState } from "@genesiscz/utils/work/model/vocab";
import { randomItemSuffix } from "@genesiscz/utils/work/service";
import { applyChange } from "@genesiscz/utils/work/store/apply";
import { openWorkDb, workDbPath } from "@genesiscz/utils/work/store/db";
import { type ItemRow, rowToItem } from "@genesiscz/utils/work/store/rows";
import { nanoid } from "nanoid";
import { captureContext } from "./context";
import { applyFilters, defaultStorageRoot, projectHash } from "./file-store";
import { parseReminders } from "./reminders";
import type { AddTodoInput, ProjectMeta, Todo, TodoFilters, TodoStatus } from "./types";

const log = logger.child({ component: "todo:store" });

/** A burst of parallel `tools todo add` processes queues on one lock; see the old store for the measure. */
const STORE_LOCK_TIMEOUT_MS = 30_000;
const POINTER = "todo";

interface PointerMeta {
    projectRoot: string;
    todo: string;
    importedFrom?: string;
}

const STATE_OF: Record<TodoStatus, ItemState> = {
    todo: "open",
    "in-progress": "active",
    blocked: "active",
    done: "done",
};

/** A worktree's todos belong to its main checkout; a folder outside git is its own root. */
export function canonicalTodoRoot(projectRoot: string): string {
    const common = gitCommonRoot(projectRoot);
    return common !== null && basename(common) === ".git" ? dirname(common) : projectRoot;
}

function actorHere(projectRoot: string): Actor {
    const identity = whoIsCallingHere();
    return {
        kind: identity.isInAgent ? "agent" : "owner",
        harness: identity.agent,
        sessionId: identity.sessionId,
        sessionTitle: null,
        model: null,
        host: null,
        subagentId: identity.subagentId ?? null,
        project: basename(projectRoot),
        repoRoot: projectRoot,
        branch: null,
        commitSha: null,
    };
}

function remindOf(todo: Todo): NonNullable<ItemFields["remind"]> {
    return [
        ...(todo.at !== undefined ? [{ at: todo.at, label: "start" }] : []),
        ...todo.reminders.map((r) => ({ at: r.at, ...(r.label !== undefined ? { label: r.label } : {}) })),
    ];
}

/** The todo as the item and its pointer hold it: the item's columns win over the copy in the pointer. */
function todoOf(item: Item, meta: PointerMeta): Todo | null {
    if (item.state === "dropped") {
        return null;
    }

    const copy = SafeJSON.parse(meta.todo) as Todo;
    const status: TodoStatus =
        item.state === "done"
            ? "done"
            : item.state === "active"
              ? copy.status === "blocked"
                  ? "blocked"
                  : "in-progress"
              : "todo";
    return {
        ...copy,
        title: item.title,
        ...(item.body !== undefined ? { description: item.body } : { description: undefined }),
        priority: item.severity ?? copy.priority,
        tags: item.tags,
        status,
    };
}

interface Row {
    item: Item;
    meta: PointerMeta;
    todoId: string;
}

function rowsOf(db: Database, where: { projectRoot?: string; todoId?: string; itemId?: string }): Row[] {
    const clauses = ["p.kind = ?"];
    const params: string[] = [POINTER];

    if (where.todoId !== undefined) {
        clauses.push("p.target = ?");
        params.push(where.todoId);
    }

    if (where.projectRoot !== undefined) {
        clauses.push("json_extract(p.meta, '$.projectRoot') = ?");
        params.push(where.projectRoot);
    }

    if (where.itemId !== undefined) {
        clauses.push("p.item = ?");
        params.push(where.itemId);
    }

    return db
        .query<ItemRow & { todoId: string; pointerMeta: string }, string[]>(`
            SELECT i.*, p.target AS todoId, p.meta AS pointerMeta
            FROM pointers p JOIN items i ON i.id = p.item
            WHERE ${clauses.join(" AND ")} ORDER BY p.ts, p.item
        `)
        .all(...params)
        .map((row) => ({
            item: rowToItem(row),
            meta: SafeJSON.parse(row.pointerMeta) as PointerMeta,
            todoId: row.todoId,
        }));
}

function inTransaction<T>(db: Database, fn: () => T): T {
    db.run("BEGIN IMMEDIATE");

    try {
        const result = fn();
        db.run("COMMIT");
        return result;
    } catch (error) {
        db.run("ROLLBACK");
        throw error;
    }
}

/** The changes that take an item from `before` to `after` (or create it); all through `applyChange`. */
function persist(
    db: Database,
    args: {
        row: Row | null;
        after: Todo;
        projectRoot: string;
        actor: Actor;
        origin?: NewChange["origin"];
        importedFrom?: string;
    }
): void {
    const { row, after, projectRoot, actor } = args;
    const ts = new Date().toISOString();
    const origin = args.origin ?? { via: "local" as const };
    const id = row?.item.id ?? asItemId(`w_${randomItemSuffix()}`);
    const base = { v: 1 as const, ts, item: id, actor, origin };
    const state: ItemState = STATE_OF[after.status];

    if (row === null) {
        applyChange(db, {
            ...base,
            kind: "created",
            payload: {
                type: "todo",
                state,
                project: basename(projectRoot),
                title: after.title,
                ...(after.description !== undefined ? { body: after.description } : {}),
                severity: after.priority,
                tags: after.tags,
                fields: { remind: remindOf(after) },
            },
        });
    } else {
        const item = row.item;
        const set: ItemPatch = {};

        if (item.title !== after.title) {
            set.title = after.title;
        }

        if ((item.body ?? undefined) !== after.description) {
            set.body = after.description ?? null;
        }

        if (item.severity !== after.priority) {
            set.severity = after.priority;
        }

        if (SafeJSON.stringify(item.tags) !== SafeJSON.stringify(after.tags)) {
            set.tags = after.tags;
        }

        const remind = remindOf(after);

        if (SafeJSON.stringify(item.fields.remind ?? []) !== SafeJSON.stringify(remind)) {
            set.fields = { remind };
        }

        if (Object.keys(set).length > 0) {
            applyChange(db, { ...base, kind: "edited", payload: { set } });
        }

        const wasBlocked = row.meta.todo.includes('"status":"blocked"');

        if (item.state !== state || (after.status === "blocked") !== wasBlocked) {
            applyChange(db, { ...base, kind: "moved", payload: { from: item.state, to: state } });
        }
    }

    const meta: PointerMeta = {
        projectRoot,
        todo: SafeJSON.stringify(after),
        ...((args.importedFrom ?? row?.meta.importedFrom)
            ? { importedFrom: args.importedFrom ?? row?.meta.importedFrom }
            : {}),
    };
    applyChange(db, {
        ...base,
        kind: "pointed",
        payload: { pointer: { kind: POINTER, target: after.id, meta: { ...meta } } },
    });
}

const imported = new Set<string>();

export class TodoStore {
    private readonly fileRoot: string;

    private constructor(
        private readonly projectRoot: string,
        private readonly storageRoot: string,
        private readonly dbPath: string,
        private readonly askedRoot: string
    ) {
        this.fileRoot = join(storageRoot, "projects", projectHash(askedRoot));
    }

    static forProject(projectRoot: string, options?: { storageRoot?: string }): TodoStore {
        const storageRoot = options?.storageRoot ?? defaultStorageRoot();
        // A test or a sandbox names its own storage root; its work store sits beside the files it imports from.
        const dbPath = options?.storageRoot !== undefined ? join(storageRoot, "work.db") : workDbPath();
        return new TodoStore(canonicalTodoRoot(projectRoot), storageRoot, dbPath, projectRoot);
    }

    getProjectRoot(): string {
        return this.projectRoot;
    }

    private withDb<T>(fn: (db: Database) => T): T {
        if (this.dbPath !== ":memory:") {
            mkdirSync(dirname(this.dbPath), { recursive: true });
        }

        const db = openWorkDb(this.dbPath);

        try {
            importFiles(db, this.dbPath, [
                fileOf(this.storageRoot, this.askedRoot),
                fileOf(this.storageRoot, this.projectRoot),
            ]);
            return fn(db);
        } finally {
            db.close();
        }
    }

    private rows(): Row[] {
        return this.withDb((db) => rowsOf(db, { projectRoot: this.projectRoot }));
    }

    async add(input: AddTodoInput): Promise<Todo> {
        const id = `todo_${nanoid(8)}`;
        // The git context of the place the todo was made: a worktree, not the main checkout its todos belong to.
        const context = await captureContext({ projectRoot: this.askedRoot });
        const inlineContent = input.mdFile ? await Bun.file(input.mdFile).text() : undefined;
        const attachments: Todo["attachments"] = [];

        if (input.attachFiles?.length) {
            const dir = join(this.fileRoot, "attachments", id);
            mkdirSync(dir, { recursive: true });

            for (const filePath of input.attachFiles) {
                const storedPath = join(dir, basename(filePath));
                copyFileSync(filePath, storedPath);
                attachments.push({ originalPath: filePath, storedPath, filename: basename(filePath) });
            }
        }

        const todo: Todo = {
            id,
            title: input.title,
            description: input.description,
            status: "todo",
            priority: input.priority ?? "medium",
            tags: input.tags ?? [],
            attachments,
            inlineContent,
            context,
            sessionId: input.sessionId,
            links: input.links ?? [],
            reminders: parseReminders(input.reminders ?? []),
            at: input.at,
        };
        const actor = actorHere(this.projectRoot);
        this.withDb((db) =>
            inTransaction(db, () => persist(db, { row: null, after: todo, projectRoot: this.projectRoot, actor }))
        );
        return todo;
    }

    async list(filters?: TodoFilters): Promise<Todo[]> {
        const todos = this.rows()
            .map((row) => todoOf(row.item, row.meta))
            .filter((t): t is Todo => t !== null);
        return filters ? applyFilters(todos, filters) : todos;
    }

    async get(id: string): Promise<Todo | null> {
        return this.withDb((db) => {
            const row = rowsOf(db, { projectRoot: this.projectRoot, todoId: id })[0];
            return row ? todoOf(row.item, row.meta) : null;
        });
    }

    /** One native side effect per todo at a time, without holding the store's own write. */
    async withSyncLock<T>(todoId: string, fn: () => Promise<T>): Promise<T> {
        mkdirSync(this.fileRoot, { recursive: true });
        const lockPath = join(this.fileRoot, `sync-${projectHash(todoId)}.lock`);
        return withFileLock(lockPath, fn, STORE_LOCK_TIMEOUT_MS);
    }

    /** Patches a todo from the row as it is at write time; `derive` must be pure and must not call the store. */
    async updateWith(id: string, derive: (current: Todo) => Partial<Todo>): Promise<Todo> {
        const actor = actorHere(this.projectRoot);
        return this.withDb((db) =>
            inTransaction(db, () => {
                const row = rowsOf(db, { projectRoot: this.projectRoot, todoId: id })[0];
                const existing = row ? todoOf(row.item, row.meta) : null;

                if (!row || existing === null) {
                    throw new Error(`Todo not found: ${id}`);
                }

                const patch = derive(existing);
                const updated: Todo = {
                    ...existing,
                    ...patch,
                    id: existing.id,
                    context: { ...existing.context, ...patch.context, updatedAt: new Date().toISOString() },
                };
                persist(db, { row, after: updated, projectRoot: this.projectRoot, actor });
                return updated;
            })
        );
    }

    async update(id: string, patch: Partial<Todo>): Promise<Todo> {
        return this.updateWith(id, () => patch);
    }

    /** A removed todo is dropped in the store (the journal keeps it) and leaves every todo list. */
    async remove(id: string): Promise<boolean> {
        const actor = actorHere(this.projectRoot);
        const removed = this.withDb((db) =>
            inTransaction(db, () => {
                const row = rowsOf(db, { projectRoot: this.projectRoot, todoId: id })[0];

                if (!row || row.item.state === "dropped") {
                    return false;
                }

                applyChange(db, {
                    v: 1,
                    ts: new Date().toISOString(),
                    item: row.item.id,
                    actor,
                    origin: { via: "local" },
                    kind: "moved",
                    payload: {
                        from: row.item.state,
                        to: "dropped",
                        why: "removed with the remove command of the todo tool",
                    },
                });
                return true;
            })
        );

        if (removed) {
            const dir = join(this.fileRoot, "attachments", id);

            if (existsSync(dir)) {
                rmSync(dir, { recursive: true, force: true });
            }
        }

        return removed;
    }

    async complete(id: string, note?: string): Promise<Todo> {
        return this.update(id, { status: "done", completedAt: new Date().toISOString(), completionNote: note });
    }

    async search(query: string): Promise<Todo[]> {
        return this.list({ search: query });
    }

    async bulkImport(incoming: Todo[]): Promise<number> {
        const actor = actorHere(this.projectRoot);
        return this.withDb((db) =>
            inTransaction(db, () => {
                let count = 0;

                for (const todo of incoming) {
                    if (rowsOf(db, { projectRoot: this.projectRoot, todoId: todo.id }).length === 0) {
                        persist(db, { row: null, after: todo, projectRoot: this.projectRoot, actor });
                        count++;
                    }
                }

                return count;
            })
        );
    }

    private static allRows(storageRoot?: string, where: Parameters<typeof rowsOf>[1] = {}): Row[] {
        const root = storageRoot ?? defaultStorageRoot();
        const dbPath = storageRoot !== undefined ? join(root, "work.db") : workDbPath();
        mkdirSync(dirname(dbPath), { recursive: true });
        const db = openWorkDb(dbPath);

        try {
            importAllFiles(db, root, dbPath);
            return rowsOf(db, where);
        } finally {
            db.close();
        }
    }

    static async listAllProjects(storageRoot?: string): Promise<ProjectMeta[]> {
        const byRoot = new Map<string, ProjectMeta>();

        for (const row of TodoStore.allRows(storageRoot)) {
            if (row.item.state === "dropped") {
                continue;
            }

            const known = byRoot.get(row.meta.projectRoot);
            byRoot.set(row.meta.projectRoot, {
                projectRoot: row.meta.projectRoot,
                name: basename(row.meta.projectRoot),
                lastAccessed:
                    known && known.lastAccessed > row.item.updatedTs ? known.lastAccessed : row.item.updatedTs,
                todoCount: (known?.todoCount ?? 0) + 1,
            });
        }

        return [...byRoot.values()];
    }

    /** Locates a todo by id in every project, so a command can name the project that holds it. */
    /** The todo an item of the work store holds, for the reminders connector. */
    static async findByItem(itemId: string, storageRoot?: string): Promise<{ todo: Todo; projectRoot: string } | null> {
        for (const row of TodoStore.allRows(storageRoot, { itemId })) {
            const todo = todoOf(row.item, row.meta);

            if (todo !== null) {
                return { todo, projectRoot: row.meta.projectRoot };
            }
        }

        return null;
    }

    /** Records that a todo is paired with an outside item (made by `--sync-to`), so the store knows the pairing. */
    async recordPairing(todoId: string, connector: string, remoteKey: string): Promise<void> {
        const row = this.withDb((db) => rowsOf(db, { projectRoot: this.projectRoot, todoId })[0]);

        if (row === undefined) {
            return;
        }

        this.withDb((db) =>
            pairItem({ db, now: () => new Date().toISOString() }, row.item.id, connector, remoteKey, "in-sync")
        );
    }

    static async findTodo(id: string, storageRoot?: string): Promise<{ todo: Todo; projectRoot: string } | null> {
        for (const row of TodoStore.allRows(storageRoot, { todoId: id })) {
            const todo = todoOf(row.item, row.meta);

            if (todo !== null) {
                return { todo, projectRoot: row.meta.projectRoot };
            }
        }

        return null;
    }

    static async listAll(filters?: TodoFilters, storageRoot?: string): Promise<Todo[]> {
        const todos = TodoStore.allRows(storageRoot)
            .map((row) => todoOf(row.item, row.meta))
            .filter((t): t is Todo => t !== null);
        return filters ? applyFilters(todos, filters) : todos;
    }
}

function updatedAtOf(todo: Todo): string {
    return todo.context?.updatedAt ?? todo.context?.createdAt ?? "";
}

/**
 * Imports the `todos.json` of these roots by (project root, todo id, updatedAt). A row whose file copy is newer than
 * the stored one was written by old code after the import; it is imported again and the file is named in a warning.
 */
function importFiles(db: Database, dbPath: string, entries: readonly { root: string; path: string }[]): void {
    for (const { root, path } of entries) {
        const key = `${dbPath}|${path}`;

        if (imported.has(key)) {
            continue;
        }

        imported.add(key);

        if (!existsSync(path)) {
            continue;
        }

        // An empty root is a store whose meta.json is gone: the todo keeps no project, and a lookup says so.
        const target = root === "" ? "" : canonicalTodoRoot(root);
        const todos = SafeJSON.parse(readFileSync(path, "utf8")) as Todo[];
        const actor = actorHere(target);

        inTransaction(db, () => {
            for (const todo of todos) {
                const row = rowsOf(db, { todoId: todo.id }).find((r) => r.meta.projectRoot === target) ?? null;
                const origin = { via: "legacy" as const, uid: `todo-file:${todo.id}:${updatedAtOf(todo)}` };

                if (row === null) {
                    persist(db, { row: null, after: todo, projectRoot: target, actor, origin, importedFrom: path });
                    continue;
                }

                const stored = SafeJSON.parse(row.meta.todo) as Todo;

                if (updatedAtOf(todo) > updatedAtOf(stored)) {
                    log.warn(
                        { path, id: todo.id },
                        "todo: a todos.json row is newer than the work store; imported it again"
                    );
                    process.stderr.write(
                        `warning: ${path} holds a newer copy of ${todo.id} (written by old code); imported it again\n`
                    );
                    persist(db, { row, after: todo, projectRoot: target, actor, origin, importedFrom: path });
                }
            }
        });
    }
}

function fileOf(storageRoot: string, root: string): { root: string; path: string } {
    return { root, path: join(storageRoot, "projects", projectHash(root), "todos.json") };
}

/** Every project folder of the old files: its `meta.json` names the root; a folder without one keeps none. */
function importAllFiles(db: Database, storageRoot: string, dbPath: string): void {
    const projectsDir = join(storageRoot, "projects");

    if (!existsSync(projectsDir)) {
        return;
    }

    const entries: { root: string; path: string }[] = [];

    for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
        const metaPath = join(projectsDir, entry.name, "meta.json");
        const path = join(projectsDir, entry.name, "todos.json");

        if (entry.isDirectory() && existsSync(path)) {
            const root = existsSync(metaPath)
                ? (SafeJSON.parse(readFileSync(metaPath, "utf8")) as ProjectMeta).projectRoot
                : "";
            entries.push({ root, path });
        }
    }

    importFiles(db, dbPath, entries);
}
