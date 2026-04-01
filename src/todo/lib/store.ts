import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { nanoid } from "nanoid";
import { captureContext } from "./context";
import { parseReminders } from "./reminders";
import type { AddTodoInput, ProjectMeta, Todo, TodoFilters } from "./types";

function projectHash(projectRoot: string): string {
    return createHash("sha256").update(projectRoot).digest("hex").slice(0, 12);
}

function defaultStorageRoot(): string {
    return join(homedir(), ".genesis-tools", "todo");
}

function applyFilters(todos: Todo[], filters: TodoFilters): Todo[] {
    let result = todos;

    if (filters.status?.length) {
        result = result.filter((t) => filters.status!.includes(t.status));
    }

    if (filters.priority?.length) {
        result = result.filter((t) => filters.priority!.includes(t.priority));
    }

    if (filters.tags?.length) {
        result = result.filter((t) => t.tags.some((tag) => filters.tags!.includes(tag)));
    }

    if (filters.sessionId) {
        result = result.filter((t) => t.sessionId === filters.sessionId);
    }

    if (filters.search) {
        const q = filters.search.toLowerCase();
        result = result.filter(
            (t) =>
                t.title.toLowerCase().includes(q) ||
                t.description?.toLowerCase().includes(q) ||
                t.inlineContent?.toLowerCase().includes(q) ||
                t.tags.some((tag) => tag.toLowerCase().includes(q))
        );
    }

    return result;
}

export class TodoStore {
    private projectRoot: string;
    private projectDir: string;
    private todosPath: string;
    private metaPath: string;
    private attachmentsDir: string;

    private constructor(projectRoot: string, storageRoot: string) {
        this.projectRoot = projectRoot;
        const hash = projectHash(projectRoot);
        this.projectDir = join(storageRoot, "projects", hash);
        this.todosPath = join(this.projectDir, "todos.json");
        this.metaPath = join(this.projectDir, "meta.json");
        this.attachmentsDir = join(this.projectDir, "attachments");
    }

    static forProject(projectRoot: string, options?: { storageRoot?: string }): TodoStore {
        return new TodoStore(projectRoot, options?.storageRoot ?? defaultStorageRoot());
    }

    private ensureDir(): void {
        if (!existsSync(this.projectDir)) {
            mkdirSync(this.projectDir, { recursive: true });
        }
    }

    private async readTodos(): Promise<Todo[]> {
        if (!existsSync(this.todosPath)) {
            return [];
        }

        const content = await Bun.file(this.todosPath).text();
        return SafeJSON.parse(content) as Todo[];
    }

    private async writeTodos(todos: Todo[]): Promise<void> {
        this.ensureDir();
        await Bun.write(this.todosPath, SafeJSON.stringify(todos, null, 2));
    }

    private async writeMeta(todos: Todo[]): Promise<void> {
        const meta: ProjectMeta = {
            projectRoot: this.projectRoot,
            name: basename(this.projectRoot),
            lastAccessed: new Date().toISOString(),
            todoCount: todos.length,
        };

        await Bun.write(this.metaPath, SafeJSON.stringify(meta, null, 2));
    }

    async add(input: AddTodoInput): Promise<Todo> {
        const id = "todo_" + nanoid(8);
        const context = await captureContext({ projectRoot: this.projectRoot });
        const reminders = parseReminders(input.reminders ?? []);
        const links = input.links ?? [];

        let inlineContent: string | undefined;

        if (input.mdFile) {
            inlineContent = await Bun.file(input.mdFile).text();
        }

        const attachments: Todo["attachments"] = [];

        if (input.attachFiles?.length) {
            const todoAttachDir = join(this.attachmentsDir, id);
            mkdirSync(todoAttachDir, { recursive: true });

            for (const filePath of input.attachFiles) {
                const filename = basename(filePath);
                const storedPath = join(todoAttachDir, filename);
                copyFileSync(filePath, storedPath);
                attachments.push({ originalPath: filePath, storedPath, filename });
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
            links,
            reminders,
        };

        const todos = await this.readTodos();
        todos.push(todo);
        await this.writeTodos(todos);
        await this.writeMeta(todos);

        return todo;
    }

    async list(filters?: TodoFilters): Promise<Todo[]> {
        const todos = await this.readTodos();

        if (!filters) {
            return todos;
        }

        return applyFilters(todos, filters);
    }

    async get(id: string): Promise<Todo | null> {
        const todos = await this.readTodos();
        return todos.find((t) => t.id === id) ?? null;
    }

    async update(id: string, patch: Partial<Todo>): Promise<Todo> {
        const todos = await this.readTodos();
        const index = todos.findIndex((t) => t.id === id);

        if (index === -1) {
            throw new Error(`Todo not found: ${id}`);
        }

        const existing = todos[index];
        const updated: Todo = {
            ...existing,
            ...patch,
            id: existing.id,
            context: {
                ...existing.context,
                ...patch.context,
                updatedAt: new Date().toISOString(),
            },
        };

        todos[index] = updated;
        await this.writeTodos(todos);
        await this.writeMeta(todos);

        return updated;
    }

    async remove(id: string): Promise<boolean> {
        const todos = await this.readTodos();
        const filtered = todos.filter((t) => t.id !== id);

        if (filtered.length === todos.length) {
            return false;
        }

        await this.writeTodos(filtered);
        await this.writeMeta(filtered);

        return true;
    }

    async complete(id: string, note?: string): Promise<Todo> {
        return this.update(id, {
            status: "done",
            completedAt: new Date().toISOString(),
            completionNote: note,
        });
    }

    async search(query: string): Promise<Todo[]> {
        const todos = await this.readTodos();
        return applyFilters(todos, { search: query });
    }

    static async listAllProjects(storageRoot?: string): Promise<ProjectMeta[]> {
        const root = storageRoot ?? defaultStorageRoot();
        const projectsDir = join(root, "projects");

        if (!existsSync(projectsDir)) {
            return [];
        }

        const entries = readdirSync(projectsDir, { withFileTypes: true });
        const projects: ProjectMeta[] = [];

        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }

            const metaPath = join(projectsDir, entry.name, "meta.json");

            if (!existsSync(metaPath)) {
                continue;
            }

            const content = await Bun.file(metaPath).text();
            projects.push(SafeJSON.parse(content) as ProjectMeta);
        }

        return projects;
    }

    static async listAll(filters?: TodoFilters, storageRoot?: string): Promise<Todo[]> {
        const root = storageRoot ?? defaultStorageRoot();
        const projectsDir = join(root, "projects");

        if (!existsSync(projectsDir)) {
            return [];
        }

        const entries = readdirSync(projectsDir, { withFileTypes: true });
        const allTodos: Todo[] = [];

        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }

            const todosPath = join(projectsDir, entry.name, "todos.json");

            if (!existsSync(todosPath)) {
                continue;
            }

            const content = await Bun.file(todosPath).text();
            const todos = SafeJSON.parse(content) as Todo[];

            if (filters) {
                allTodos.push(...applyFilters(todos, filters));
            } else {
                allTodos.push(...todos);
            }
        }

        return allTodos;
    }
}
