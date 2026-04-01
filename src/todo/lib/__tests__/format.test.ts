import { SafeJSON } from "@app/utils/json";
import { describe, expect, it } from "bun:test";
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

    describe("ai format", () => {
        it("includes id, title, priority and status on first line", () => {
            const output = formatTodo(todo, "ai");
            expect(output).toContain("[todo_x7k2m] Fix auth bug (critical, in-progress)");
        });

        it("includes tags", () => {
            const output = formatTodo(todo, "ai");
            expect(output).toContain("tags: auth, backend");
        });

        it("includes branch and commit", () => {
            const output = formatTodo(todo, "ai");
            expect(output).toContain("branch: feat/auth");
            expect(output).toContain("commit: abc1234");
        });

        it("includes session", () => {
            const output = formatTodo(todo, "ai");
            expect(output).toContain("session: ses_xyz");
        });

        it("includes links", () => {
            const output = formatTodo(todo, "ai");
            expect(output).toContain("links: pr:142, ado:78901");
        });

        it("includes reminders", () => {
            const output = formatTodo(todo, "ai");
            expect(output).toContain("reminders: 2026-04-02T12:00:00Z, 2026-04-03T12:00:00Z");
        });

        it("includes description after separator", () => {
            const output = formatTodo(todo, "ai");
            expect(output).toContain("---\nThe OAuth flow breaks");
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
            expect(output).not.toContain("tags:");
            expect(output).not.toContain("links:");
            expect(output).not.toContain("reminders:");
            expect(output).not.toContain("session:");
            expect(output).not.toContain("branch:");
        });
    });

    describe("md format", () => {
        it("includes header with id and title", () => {
            const output = formatTodo(todo, "md");
            expect(output).toContain("## todo_x7k2m: Fix auth bug");
        });

        it("includes status and priority", () => {
            const output = formatTodo(todo, "md");
            expect(output).toContain("**Status:** in-progress");
            expect(output).toContain("**Priority:** critical");
        });

        it("includes tags", () => {
            const output = formatTodo(todo, "md");
            expect(output).toContain("**Tags:** auth, backend");
        });

        it("includes context section with branch and commit", () => {
            const output = formatTodo(todo, "md");
            expect(output).toContain("### Context");
            expect(output).toContain("- Branch: `feat/auth`");
            expect(output).toContain("- Commit: `abc12345`");
        });

        it("includes description section", () => {
            const output = formatTodo(todo, "md");
            expect(output).toContain("### Description");
            expect(output).toContain("The OAuth flow breaks");
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

    it("ai format joins with double newline", () => {
        const output = formatTodoList(todos, "ai");
        expect(output).toContain("[todo_x7k2m]");
        expect(output).toContain("[todo_abc12]");
        expect(output).toContain("\n\n");
    });

    it("md format produces bullet list", () => {
        const output = formatTodoList(todos, "md");
        expect(output).toContain("- **todo_x7k2m**:");
        expect(output).toContain("- **todo_abc12**:");
    });

    it("table format includes all rows", () => {
        const output = formatTodoList(todos, "table");
        expect(output).toContain("todo_x7k2m");
        expect(output).toContain("todo_abc12");
    });

    it("handles empty list", () => {
        expect(formatTodoList([], "md")).toContain("No todos");
        expect(formatTodoList([], "table")).toContain("No todos");
        expect(formatTodoList([], "ai")).toBe("");
    });
});
