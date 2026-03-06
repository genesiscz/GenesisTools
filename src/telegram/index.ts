import { handleReadmeFlag } from "@app/utils/readme";
import { Command } from "commander";
import { registerConfigureCommand } from "./commands/configure";
import { registerContactsCommand } from "./commands/contacts";
import { registerHistoryCommand } from "./commands/history";
import { registerListenCommand } from "./commands/listen";
import { registerWatchCommand } from "./commands/watch";

handleReadmeFlag(import.meta.url);

const program = new Command();
program
    .name("telegram")
    .description("Telegram MTProto user client — listen for messages and auto-respond")
    .version("1.0.0")
    .showHelpAfterError(true);

registerConfigureCommand(program);
registerWatchCommand(program);
registerListenCommand(program);
registerContactsCommand(program);
registerHistoryCommand(program);

program.parseAsync().catch((err) => {
    console.error(err);
    process.exit(1);
});
