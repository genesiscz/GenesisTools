import { Command } from "commander";
import { runTool } from "../commander";

const program = new Command("boundary");

program.command("boom").action(() => {
    throw new Error("boom");
});

await runTool(program, { tool: "boundary" });
