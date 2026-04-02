import { describe, expect, it } from "bun:test";
import { SafeJSON } from "@app/utils/json";
import { formatTodo, formatTodoList } from "../format";
import type { Todo } from "../types";

function makeTodo(overrides?: Partial<Todo>): Todo {
    return {
        id: "todo_x7k2m",
        title: "Fix auth bug",
        description: "The OAuth flow breaks when token expires",
        status: "in-progress",
        priority: "critical",
        tags: ["auth", "backend"],
        attachments: [],
        context: {
            git: {
                branch: "feat/auth",
                commitSha: "abc1234567890",
                commitMessage: "Fix login flow",
                stagedFiles: [],
                unstagedFiles: [],
                untrackedFiles: [],
            },
            cwd: "/projects/myapp",
            projectRoot: "/projects/myapp",
            hostname: "devbox",
            createdAt: "2026-04-01T10:00:00Z",
            updatedAt: "2026-04-01T12:00:00Z",
        },
        sessionId: "ses_xyz",
        links: [
            { type: "pr", ref: "142" },
            { type: "ado", ref: "78901" },
        ],
        reminders: [
            { at: "2026-04-02T12:00:00Z", synced: null },
            { at: "2026-04-03T12:00:00Z", synced: null },
        ],
        ...overrides,
    };
}

describe("formatTodo", () => {
    const todo = makeTodo();

    describe("json format", () => {
        it("produces valid JSON with all fields", () => {
            const output = formatTodo(todo, "json");
            const parsed = SafeJSON.parse(output);
            expect(parsed.id).toBe("todo_x7k2m");
            expect(parsed.title).toBe("Fix auth bug");
            expect(parsed.priority).toBe("critical");
        });
    });

    describe("ai/md format (markdown)", () => {
        it("includes title in heading", () => {
            const output = formatTodo(todo, "ai");
            expect(output).toContain("Fix auth bug");
        });

        it("includes id, priority, and status", () => {
            const output = formatTodo(todo, "ai");
            expect(output).toContain("todo_x7k2m");
            expect(output).toContain("critical");
            expect(output).toContain("in-progress");
        });

        it("includes tags", () => {
            const output = formatTodo(todo, "ai");
            expect(output).toContain("auth");
            expect(output).toContain("backend");
        });

        it("includes branch and commit", () => {
            const output = formatTodo(todo, "ai");
            expect(output).toContain("feat/auth");
            expect(output).toContain("abc12345");
        });

        it("includes session", () => {
            const output = formatTodo(todo, "ai");
            expect(output).toContain("ses_xyz");
        });

        it("includes links", () => {
            const output = formatTodo(todo, "ai");
            expect(output).toContain("pr:142");
            expect(output).toContain("ado:78901");
        });

        it("includes reminders", () => {
            const output = formatTodo(todo, "ai");
            expect(output).toContain("2026-04-02T12:00:00Z");
            expect(output).toContain("2026-04-03T12:00:00Z");
        });

        it("includes description", () => {
            const output = formatTodo(todo, "ai");
            expect(output).toContain("The OAuth flow breaks");
        });

        it("skips empty sections", () => {
            const minimal = makeTodo({
                tags: [],
                links: [],
                reminders: [],
                description: undefined,
                sessionId: undefined,
                context: {
                    ...todo.context,
                    git: undefined,
                },
            });
            const output = formatTodo(minimal, "ai");
            expect(output).not.toContain("Tags:");
            expect(output).not.toContain("Links:");
            expect(output).not.toContain("Reminders:");
            expect(output).not.toContain("Session:");
            expect(output).not.toContain("Branch:");
        });

        it("md format produces same markdown as ai", () => {
            const ai = formatTodo(todo, "ai");
            const md = formatTodo(todo, "md");
            expect(ai).toBe(md);
        });

        it("shows status icon for done todos", () => {
            const done = makeTodo({ status: "done", completedAt: "2026-04-01T15:00:00Z" });
            const output = formatTodo(done, "ai");
            expect(output).toContain("[x]");
        });

        it("shows status icon for blocked todos", () => {
            const blocked = makeTodo({ status: "blocked" });
            const output = formatTodo(blocked, "ai");
            expect(output).toContain("[!]");
        });
    });

    describe("table format", () => {
        it("includes header row and todo data", () => {
            const output = formatTodo(todo, "table");
            expect(output).toContain("ID");
            expect(output).toContain("Status");
            expect(output).toContain("Priority");
            expect(output).toContain("Title");
            expect(output).toContain("todo_x7k2m");
            expect(output).toContain("critical");
        });
    });
});

describe("formatTodoList", () => {
    const todos = [
        makeTodo(),
        makeTodo({ id: "todo_abc12", title: "Second task", status: "todo", priority: "low", tags: [] }),
    ];

    it("json format returns array", () => {
        const output = formatTodoList(todos, "json");
        const parsed = SafeJSON.parse(output);
        expect(parsed).toHaveLength(2);
    });

    it("ai format includes all todos", () => {
        const output = formatTodoList(todos, "ai");
        expect(output).toContain("Fix auth bug");
        expect(output).toContain("Second task");
    });

    it("ai format separates todos", () => {
        const output = formatTodoList(todos, "ai");
        expect(output).toContain("---");
    });

    it("table format includes all rows", () => {
        const output = formatTodoList(todos, "table");
        expect(output).toContain("todo_x7k2m");
        expect(output).toContain("todo_abc12");
    });

    it("handles empty list for md", () => {
        expect(formatTodoList([], "md")).toContain("No todos");
    });

    it("handles empty list for table", () => {
        expect(formatTodoList([], "table")).toContain("No todos");
    });
});
