import type { TodosResult } from "@dd/contract";
import { describe, expect, it } from "bun:test";
import { mockDashboardClient } from "@/api/mock-client";
import {
    addTodo,
    completeTodo,
    requestTodosAccess,
    TODOS_INTERVAL_MS,
    todosKeys,
    todosListQuery,
} from "@/features/reminders-todos/queries";

/**
 * Proves the reminders-todos data layer flows through the typed `client.todos.*` seam WITHOUT a
 * React renderer — we exercise the mock client + the `todosListQuery` factory's `queryFn` directly
 * (exactly what `useQuery` calls). The mock is STATEFUL (seed + add/complete mutate the array), which
 * is what makes the Appium "complete removes a row" / "add appears" assertions trustworthy. Mirrors
 * features/obsidian/queries.test.ts + features/daemon/queries.test.ts.
 */

describe("mock dashboard client — todos", () => {
    it("todos.list() returns seeded reminders with string identifier + title + boolean is_completed", async () => {
        const { lists, reminders } = await mockDashboardClient.todos.list();
        expect(reminders.length).toBeGreaterThan(0);
        expect(lists.length).toBeGreaterThan(0);

        for (const reminder of reminders) {
            expect(typeof reminder.identifier).toBe("string");
            expect(typeof reminder.title).toBe("string");
            expect(typeof reminder.is_completed).toBe("boolean");
        }
    });

    it("todos.add({ title }) returns a { reminderId } and the new title appears in a subsequent list", async () => {
        const title = `Unit added ${Date.now()}`;
        const before = (await mockDashboardClient.todos.list()).reminders.length;

        const { reminderId } = await mockDashboardClient.todos.add({ title });
        expect(typeof reminderId).toBe("string");

        const after = await mockDashboardClient.todos.list();
        expect(after.reminders.length).toBe(before + 1);
        expect(after.reminders.some((r) => r.title === title)).toBe(true);
    });

    it("todos.complete(id) returns { ok: true } AND drops the row from a subsequent list (stateful mock)", async () => {
        const { reminderId } = await mockDashboardClient.todos.add({ title: "to be completed" });
        expect((await mockDashboardClient.todos.list()).reminders.some((r) => r.identifier === reminderId)).toBe(true);

        const res = await mockDashboardClient.todos.complete(reminderId);
        expect(res.ok).toBe(true);

        const after = await mockDashboardClient.todos.list();
        expect(after.reminders.some((r) => r.identifier === reminderId)).toBe(false);
    });

    it("todos.requestAccess() resolves with a granted flag", async () => {
        const res = await mockDashboardClient.todos.requestAccess();
        expect(typeof res.granted).toBe("boolean");
    });
});

describe("todos query factory", () => {
    it("todosListQuery builds the list key (unique 'todos' root) + interval + a queryFn returning a TodosResult", async () => {
        const opts = todosListQuery(mockDashboardClient);
        expect([...opts.queryKey]).toEqual([...todosKeys.list(false)]);
        expect(opts.queryKey[0]).toBe("todos");
        expect(opts.refetchInterval).toBe(TODOS_INTERVAL_MS);
        expect(typeof opts.queryFn).toBe("function");

        const data = await (opts.queryFn as unknown as () => Promise<TodosResult>)();
        expect(Array.isArray(data.reminders)).toBe(true);
        expect(data.reminders.length).toBeGreaterThan(0);
    });

    it("todosKeys.list encodes includeCompleted into the key", () => {
        expect([...todosKeys.list(true)]).toEqual(["todos", "list", true]);
        expect([...todosKeys.list(false)]).toEqual(["todos", "list", false]);
    });
});

describe("todos mutation callers", () => {
    it("addTodo(client, { title }) resolves to { reminderId }", async () => {
        const res = await addTodo(mockDashboardClient, { title: "via caller" });
        expect(typeof res.reminderId).toBe("string");
    });

    it("completeTodo(client, id) resolves to { ok: true }", async () => {
        const { reminderId } = await addTodo(mockDashboardClient, { title: "complete via caller" });
        const res = await completeTodo(mockDashboardClient, reminderId);
        expect(res.ok).toBe(true);
    });

    it("requestTodosAccess(client) resolves", async () => {
        const res = await requestTodosAccess(mockDashboardClient);
        expect(res).toBeDefined();
    });
});
