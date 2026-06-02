import { addCommand, deleteCommand, listCommands } from "@app/dev-dashboard/lib/commands/store";
import type { SavedCommandInput } from "@app/dev-dashboard/lib/commands/types";
import { errorResult } from "@app/dev-dashboard/server/routes/error";
import type { RouteDef } from "@app/dev-dashboard/server/types";

export function commandsRoutes(): RouteDef[] {
    return [
        {
            method: "GET",
            pattern: "/api/commands",
            handler: async () => {
                try {
                    return { kind: "json", status: 200, body: { commands: await listCommands() } };
                } catch (err) {
                    return errorResult(err);
                }
            },
        },
        {
            method: "POST",
            pattern: "/api/commands",
            handler: async (ctx) => {
                try {
                    const body = await ctx.readJson<SavedCommandInput>();
                    const command = await addCommand(body);

                    return { kind: "json", status: 200, body: { command } };
                } catch (err) {
                    return errorResult(err, 400);
                }
            },
        },
        {
            method: "DELETE",
            pattern: "/api/commands",
            handler: async (ctx) => {
                try {
                    const body = await ctx.readJson<{ id: string }>();
                    const removed = await deleteCommand(body.id);

                    return { kind: "json", status: 200, body: { removed } };
                } catch (err) {
                    return errorResult(err);
                }
            },
        },
    ];
}
