import { ENDPOINTS } from "@app/dev-dashboard/contract/endpoint-table";
import { addCommand, deleteCommand, listCommands } from "@app/dev-dashboard/lib/commands/store";
import type { SavedCommandInput } from "@app/dev-dashboard/lib/commands/types";
import { bindHandler } from "@app/dev-dashboard/server/bind";
import { errorResult } from "@app/dev-dashboard/server/routes/error";
import type { RouteDef } from "@app/dev-dashboard/server/types";

export function commandsRoutes(): RouteDef[] {
    return [
        bindHandler(ENDPOINTS.commands, async () => {
            try {
                return { kind: "json", status: 200, body: { commands: await listCommands() } };
            } catch (err) {
                return errorResult(err);
            }
        }),
        bindHandler(ENDPOINTS.commandsCreate, async (ctx) => {
            try {
                const body = await ctx.readJson<SavedCommandInput>();
                const command = await addCommand(body);

                return { kind: "json", status: 200, body: { command } };
            } catch (err) {
                return errorResult(err, 400);
            }
        }),
        bindHandler(ENDPOINTS.commandsDelete, async (ctx) => {
            try {
                const body = await ctx.readJson<{ id: string }>();
                const removed = await deleteCommand(body.id);

                return { kind: "json", status: 200, body: { removed } };
            } catch (err) {
                return errorResult(err);
            }
        }),
    ];
}
