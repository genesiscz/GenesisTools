import { PromptCancelledError } from "@genesiscz/utils/prompts/cancel";
import { Command } from "commander";
import { runTool } from "../commander";

const program = new Command("boundary");

program.command("boom").action(() => {
    throw new Error("boom");
});

program.command("cancel").action(() => {
    throw new PromptCancelledError();
});

program.command("legacy-cancel").action(() => {
    throw new Error("Cancelled");
});

await runTool(program, { tool: "boundary" });
