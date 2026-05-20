import { out } from "@app/logger";
import { MacCalendar } from "@app/utils/macos/apple-calendar";
import type { Command } from "commander";
import pc from "picocolors";

export function registerDeleteCommand(program: Command): void {
    program
        .command("delete <event-id>")
        .description("Delete a calendar event by its identifier")
        .action(async (eventId: string) => {
            try {
                const ok = await MacCalendar.deleteEvent({ eventId });

                if (ok) {
                    out.println(`${pc.green("Event deleted")} — ID: ${eventId}`);
                } else {
                    out.error(`${pc.red("Failed to delete event")} — ID: ${eventId}`);
                    process.exit(1);
                }
            } catch (error) {
                out.error(error instanceof Error ? error.message : String(error));
                process.exit(1);
            }
        });
}
