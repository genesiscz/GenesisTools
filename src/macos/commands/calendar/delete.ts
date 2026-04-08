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
                    console.log(`${pc.green("Event deleted")} — ID: ${eventId}`);
                } else {
                    console.error(`${pc.red("Failed to delete event")} — ID: ${eventId}`);
                    process.exit(1);
                }
            } catch (error) {
                console.error(error instanceof Error ? error.message : String(error));
                process.exit(1);
            }
        });
}
