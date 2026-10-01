import { runTool } from "@genesiscz/utils/cli";
import { Command } from "commander";
import { registerServeCommand } from "./server/command";

/** `tools hub serve` alone (see `index.ts`): the resident server must not hold the full hub CLI's ~530 modules. */
const program = new Command().name("hub").description("The GenesisTools.app agent hub: the resident server");

registerServeCommand(program);

await runTool(program, { tool: "hub" });
