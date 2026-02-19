import { Command } from "commander";
import { registerStartCommand } from "./commands/start";
import { registerGetCommand } from "./commands/get";
import { registerExpandCommand } from "./commands/expand";
import { registerSnippetCommand } from "./commands/snippet";
import { registerSessionsCommand } from "./commands/sessions";
import { registerTailCommand } from "./commands/tail";
import { registerCleanupCommand } from "./commands/cleanup";
import { registerDiffCommand } from "./commands/diff";

const program = new Command();

program
	.name("debugging-master")
	.description("LLM debugging toolkit — instrumentation + token-efficient log reader")
	.option("--session <name>", "Session name (fuzzy-matched)")
	.option("--format <type>", "Output format: ai (default), json, md", "ai")
	.option("--pretty", "Enhanced human-readable output (colors, box drawing)")
	.option("-v, --verbose", "Verbose logging");

registerStartCommand(program);
registerGetCommand(program);
registerExpandCommand(program);
registerSnippetCommand(program);
registerSessionsCommand(program);
registerTailCommand(program);
registerCleanupCommand(program);
registerDiffCommand(program);

program.parse();
