import { Command } from "commander";
import { handleReadmeFlag } from "@app/utils/readme";
import { registerConfigureCommand } from "./commands/configure";
import { registerListenCommand } from "./commands/listen";
import { registerContactsCommand } from "./commands/contacts";

handleReadmeFlag(import.meta.url);

const program = new Command();
program
	.name("telegram")
	.description("Telegram MTProto user client — listen for messages and auto-respond")
	.version("1.0.0")
	.showHelpAfterError(true);

registerConfigureCommand(program);
registerListenCommand(program);
registerContactsCommand(program);

program.parseAsync();
