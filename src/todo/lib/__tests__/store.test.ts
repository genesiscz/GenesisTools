import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TodoStore } from "../store";
import type { Todo } from "../types";

const TEST_DIR = join(import.meta.dir, `.test-store-${Date.now()}`);

let store: TodoStore;

beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    store = TodoStore.forProject(TEST_DIR, { storageRoot: join(TEST_DIR, ".storage") });
});

afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("add()", () => {
    it("creates a todo with generated id", async () => {
        const todo = await store.add({ title: "Write tests" });

        expect(todo.id).toMatch(/^todo_/);
        expect(todo.id).toHaveLength("todo_".length + 8);
        expect(todo.title).toBe("Write tests");
    });

    it("persists to disk", async () => {
        await store.add({ title: "Persist me" });
        const todos = await store.list();

        expect(todos).toHaveLength(1);
        expect(todos[0].title).toBe("Persist me");
    });

    it("respects priority and tags", async () => {
        const todo = await store.add({
            title: "Urgent fix",
            priority: "critical",
            tags: ["bug", "hotfix"],
        });

        expect(todo.priority).toBe("critical");
        expect(todo.tags).toEqual(["bug", "hotfix"]);
    });

    it("defaults status to 'todo' and priority to 'medium'", async () => {
        const todo = await store.add({ title: "Defaults check" });

        expect(todo.status).toBe("todo");
        expect(todo.priority).toBe("medium");
        expect(todo.tags).toEqual([]);
    });

    it("captures context with projectRoot", async () => {
        const todo = await store.add({ title: "Context check" });

        expect(todo.context).toBeDefined();
        expect(todo.context.projectRoot).toBe(TEST_DIR);
        expect(todo.context.createdAt).toBeTruthy();
    });

    it("stores sessionId when provided", async () => {
        const todo = await store.add({ title: "Session todo", sessionId: "abc-123" });

        expect(todo.sessionId).toBe("abc-123");
    });

    it("parses reminders from string inputs", async () => {
        const todo = await store.add({
            title: "Reminder test",
            reminders: ["2030-01-01T12:00:00Z"],
        });

        expect(todo.reminders).toHaveLength(1);
        expect(todo.reminders[0].at).toBe("2030-01-01T12:00:00.000Z");
    });

    it("reads mdFile content as inlineContent", async () => {
        const mdPath = join(TEST_DIR, "notes.md");
        writeFileSync(mdPath, "# My Notes\nSome content here.");

        const todo = await store.add({ title: "MD todo", mdFile: mdPath });

        expect(todo.inlineContent).toBe("# My Notes\nSome content here.");
    });

    it("copies attached files", async () => {
        const filePath = join(TEST_DIR, "data.txt");
        writeFileSync(filePath, "file content");

        const todo = await store.add({ title: "Attach test", attachFiles: [filePath] });

        expect(todo.attachments).toHaveLength(1);
        expect(todo.attachments[0].filename).toBe("data.txt");
        expect(todo.attachments[0].originalPath).toBe(filePath);

        const storedContent = await Bun.file(todo.attachments[0].storedPath).text();
        expect(storedContent).toBe("file content");
    });
});

describe("get()", () => {
    it("returns todo by id", async () => {
        const added = await store.add({ title: "Find me" });
        const found = await store.get(added.id);

        expect(found).not.toBeNull();
        expect(found!.title).toBe("Find me");
    });

    it("returns null for non-existent id", async () => {
        const found = await store.get("todo_nonexist");

        expect(found).toBeNull();
    });
});

describe("update()", () => {
    it("updates fields", async () => {
        const added = await store.add({ title: "Original" });
        const updated = await store.update(added.id, { title: "Updated", priority: "high" });

        expect(updated.title).toBe("Updated");
        expect(updated.priority).toBe("high");
    });

    it("updates updatedAt timestamp", async () => {
        const added = await store.add({ title: "Timestamp check" });
        const originalUpdatedAt = added.context.updatedAt;

        await new Promise((r) => setTimeout(r, 10));
        const updated = await store.update(added.id, { title: "Changed" });

        expect(updated.context.updatedAt).not.toBe(originalUpdatedAt);
    });

    it("throws for non-existent id", async () => {
        expect(store.update("todo_nonexist", { title: "Nope" })).rejects.toThrow();
    });
});

describe("remove()", () => {
    it("deletes a todo", async () => {
        const added = await store.add({ title: "Delete me" });
        const removed = await store.remove(added.id);

        expect(removed).toBe(true);

        const found = await store.get(added.id);
        expect(found).toBeNull();
    });

    it("returns false for non-existent id", async () => {
        const removed = await store.remove("todo_nonexist");

        expect(removed).toBe(false);
    });
});

describe("complete()", () => {
    it("sets status to 'done' and completedAt", async () => {
        const added = await store.add({ title: "Finish this" });
        const completed = await store.complete(added.id);

        expect(completed.status).toBe("done");
        expect(completed.completedAt).toBeTruthy();
    });

    it("stores completionNote", async () => {
        const added = await store.add({ title: "Note test" });
        const completed = await store.complete(added.id, "Shipped in v2.0");

        expect(completed.completionNote).toBe("Shipped in v2.0");
    });
});

describe("list() with filters", () => {
    beforeEach(async () => {
        await store.add({ title: "Open bug", priority: "high", tags: ["bug"] });
        await store.add({ title: "Done feature", priority: "low", tags: ["feature"] });
        await store.add({ title: "Blocked task", priority: "medium", tags: ["bug", "backend"], sessionId: "sess-1" });

        const todos = await store.list();
        const doneTodo = todos.find((t: Todo) => t.title === "Done feature");

        if (doneTodo) {
            await store.complete(doneTodo.id);
        }
    });

    it("returns all todos without filters", async () => {
        const todos = await store.list();

        expect(todos).toHaveLength(3);
    });

    it("filters by status", async () => {
        const done = await store.list({ status: ["done"] });

        expect(done).toHaveLength(1);
        expect(done[0].title).toBe("Done feature");
    });

    it("filters by priority", async () => {
        const high = await store.list({ priority: ["high"] });

        expect(high).toHaveLength(1);
        expect(high[0].title).toBe("Open bug");
    });

    it("filters by tag", async () => {
        const bugs = await store.list({ tags: ["bug"] });

        expect(bugs).toHaveLength(2);
    });

    it("filters by sessionId", async () => {
        const session = await store.list({ sessionId: "sess-1" });

        expect(session).toHaveLength(1);
        expect(session[0].title).toBe("Blocked task");
    });

    it("combines multiple filters", async () => {
        const result = await store.list({ tags: ["bug"], priority: ["medium"] });

        expect(result).toHaveLength(1);
        expect(result[0].title).toBe("Blocked task");
    });
});

describe("search()", () => {
    beforeEach(async () => {
        await store.add({ title: "Fix login bug", description: "Users can't authenticate" });
        await store.add({ title: "Add dashboard", tags: ["frontend"] });
        await store.add({ title: "Refactor API" });
    });

    it("finds by title substring", async () => {
        const results = await store.search("login");

        expect(results).toHaveLength(1);
        expect(results[0].title).toBe("Fix login bug");
    });

    it("finds by description substring", async () => {
        const results = await store.search("authenticate");

        expect(results).toHaveLength(1);
        expect(results[0].title).toBe("Fix login bug");
    });

    it("is case-insensitive", async () => {
        const results = await store.search("DASHBOARD");

        expect(results).toHaveLength(1);
        expect(results[0].title).toBe("Add dashboard");
    });

    it("finds by tag", async () => {
        const results = await store.search("frontend");

        expect(results).toHaveLength(1);
        expect(results[0].title).toBe("Add dashboard");
    });

    it("returns empty for no match", async () => {
        const results = await store.search("nonexistent");

        expect(results).toHaveLength(0);
    });
});

describe("cross-project operations", () => {
    it("listAllProjects returns project metadata", async () => {
        const storageRoot = join(TEST_DIR, ".storage");
        const store1 = TodoStore.forProject(join(TEST_DIR, "project-a"), { storageRoot });
        const store2 = TodoStore.forProject(join(TEST_DIR, "project-b"), { storageRoot });

        await store1.add({ title: "Task A" });
        await store2.add({ title: "Task B" });

        const projects = await TodoStore.listAllProjects(storageRoot);

        expect(projects).toHaveLength(2);
        expect(projects.every((p: { todoCount: number }) => p.todoCount === 1)).toBe(true);
    });

    it("listAll aggregates todos across projects", async () => {
        const storageRoot = join(TEST_DIR, ".storage");
        const store1 = TodoStore.forProject(join(TEST_DIR, "project-a"), { storageRoot });
        const store2 = TodoStore.forProject(join(TEST_DIR, "project-b"), { storageRoot });

        await store1.add({ title: "Task A", priority: "high" });
        await store2.add({ title: "Task B", priority: "low" });

        const all = await TodoStore.listAll(undefined, storageRoot);

        expect(all).toHaveLength(2);
    });

    it("listAll applies filters across projects", async () => {
        const storageRoot = join(TEST_DIR, ".storage");
        const store1 = TodoStore.forProject(join(TEST_DIR, "project-a"), { storageRoot });
        const store2 = TodoStore.forProject(join(TEST_DIR, "project-b"), { storageRoot });

        await store1.add({ title: "Task A", priority: "high" });
        await store2.add({ title: "Task B", priority: "low" });

        const highOnly = await TodoStore.listAll({ priority: ["high"] }, storageRoot);

        expect(highOnly).toHaveLength(1);
        expect(highOnly[0].title).toBe("Task A");
    });
});
