import { ReplToolset, type ToolsetContext } from "@genesiscz/utils/repl/toolset";
import { computerApi } from "./descriptor";
import type { ComputerUse } from "./session";

/** The REPL's `computer` global: the native Computer Use API, its artifacts in the worker's scratch folder. */
export class ComputerToolset extends ReplToolset {
    readonly api = computerApi;
    private computer?: ComputerUse;

    async bootstrap(ctx: ToolsetContext): Promise<Record<string, unknown>> {
        // Loaded here, not at the top: the parent reads only the descriptor, and session.ts is the heavy part.
        const { ComputerUse } = await import("./session");
        this.computer = new ComputerUse({ artifactDirectory: ctx.scratchDir });
        return { computer: this.computer };
    }

    override async dispose(): Promise<void> {
        this.computer?.close_session();
        this.computer = undefined;
    }
}
