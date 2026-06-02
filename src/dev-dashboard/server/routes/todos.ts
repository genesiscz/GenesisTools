import {
    addTodo,
    completeTodo,
    deleteTodo,
    listTodos,
    RemindersPermissionError,
    requestTodosAccess,
    updateTodo,
} from "@app/dev-dashboard/lib/todos/service";
import { errorResult } from "@app/dev-dashboard/server/routes/error";
import type { RouteDef } from "@app/dev-dashboard/server/types";

export function todosRoutes(): RouteDef[] {
    return [
        {
            method: "GET",
            pattern: "/api/todos",
            handler: async (ctx) => {
                const listIdsParam = ctx.query.get("listIds") ?? ctx.query.get("lists");
                const listIds = listIdsParam
                    ? listIdsParam
                          .split(",")
                          .map((id) => id.trim())
                          .filter((id) => id.length > 0)
                    : [];
                const includeCompleted = ctx.query.get("includeCompleted") === "true";

                try {
                    return { kind: "json", status: 200, body: await listTodos(listIds, { includeCompleted }) };
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    const denied =
                        err instanceof RemindersPermissionError ||
                        /permission|privacy|reminders|authoriz/i.test(message);

                    return {
                        kind: "json",
                        status: denied ? 503 : 500,
                        body: {
                            error: denied
                                ? "Reminders permission denied. Grant in System Settings → Privacy & Security → Reminders."
                                : message,
                        },
                    };
                }
            },
        },
        {
            method: "POST",
            pattern: "/api/todos/request-access",
            handler: async () => {
                try {
                    return { kind: "json", status: 200, body: await requestTodosAccess() };
                } catch (err) {
                    return errorResult(err);
                }
            },
        },
        {
            method: "POST",
            pattern: "/api/todos",
            handler: async (ctx) => {
                try {
                    const body = await ctx.readJson<{
                        title: string;
                        listName?: string;
                        due?: string;
                        priority?: "none" | "low" | "medium" | "high";
                        notes?: string;
                    }>();
                    const result = await addTodo({
                        title: body.title,
                        listName: body.listName ?? "GenesisTools",
                        due: body.due,
                        priority: body.priority,
                        notes: body.notes,
                    });

                    return { kind: "json", status: 200, body: result };
                } catch (err) {
                    return errorResult(err);
                }
            },
        },
        {
            method: "POST",
            pattern: "/api/todos/complete",
            handler: async (ctx) => {
                try {
                    const body = await ctx.readJson<{ reminderId: string }>();
                    await completeTodo(body.reminderId);

                    return { kind: "json", status: 200, body: { ok: true } };
                } catch (err) {
                    return errorResult(err);
                }
            },
        },
        {
            method: "PATCH",
            pattern: "/api/todos",
            handler: async (ctx) => {
                try {
                    const body = await ctx.readJson<{
                        reminderId: string;
                        listIdentifier: string;
                        title: string;
                        notes?: string;
                        due?: string | null;
                        priority?: "none" | "low" | "medium" | "high";
                        url?: string;
                    }>();

                    await updateTodo({
                        reminderId: body.reminderId,
                        listIdentifier: body.listIdentifier,
                        title: body.title,
                        notes: body.notes,
                        due: body.due,
                        priority: body.priority,
                        url: body.url,
                    });

                    return { kind: "json", status: 200, body: { ok: true } };
                } catch (err) {
                    return errorResult(err);
                }
            },
        },
        {
            method: "DELETE",
            pattern: "/api/todos",
            handler: async (ctx) => {
                try {
                    const body = await ctx.readJson<{ reminderId: string }>();
                    await deleteTodo(body.reminderId);

                    return { kind: "json", status: 200, body: { ok: true } };
                } catch (err) {
                    return errorResult(err);
                }
            },
        },
    ];
}
