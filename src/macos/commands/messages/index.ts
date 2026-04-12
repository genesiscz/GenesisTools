import type { Command } from "commander";
import { registerMessagesListCommand } from "./list";
import { registerMessagesSearchCommand } from "./search";
import { registerMessagesShowCommand } from "./show";

export function registerMessagesCommand(program: Command): void {
    const messages = program.command("messages").description("Read and search iMessage conversations");

    registerMessagesListCommand(messages);
    registerMessagesSearchCommand(messages);
    registerMessagesShowCommand(messages);
}
