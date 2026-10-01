import { runTool } from "@genesiscz/utils/cli";
import { Command } from "commander";
import { registerAgentsCommand } from "./commands/agents";

/** `tools hub agents …` alone (see `index.ts`); `tools hub --help` still lists every command through `cli.ts`. */
const program = new Command()
    .name("hub")
    .description("The GenesisTools.app agent hub: the agents doors (sub-agents, teammates, workers, mail, counts)");

registerAgentsCommand(program);

await runTool(program, { tool: "hub" });
