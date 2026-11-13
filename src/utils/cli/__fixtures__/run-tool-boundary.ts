import { PromptCancelledError } from "@genesiscz/utils/prompts/cancel";
import { Command } from "commander";
import { runTool, type ToolErrorReport } from "../commander";

const program = new Command("boundary");

for (const message of ["boom", "formatted", "formatter-throws"]) {
    program.command(message).action(() => {
        throw new Error(message);
    });
}

program.command("cancel").action(() => {
    throw new PromptCancelledError();
});

program.command("legacy-cancel").action(() => {
    throw new Error("Cancelled");
});

/** Only the two errors named for it get a tool report; every other error keeps the default one. */
function formatError(error: unknown): ToolErrorReport | undefined {
    const message = error instanceof Error ? error.message : "";

    if (message === "formatted") {
        return { message: "custom report", exitCode: 3 };
    }

    if (message === "formatter-throws") {
        throw new Error("the formatter broke");
    }

    return undefined;
}

await runTool(program, { tool: "boundary", formatError });
