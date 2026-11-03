import { appendFileSync } from "node:fs";
import { defineApi, defineMethod } from "@genesiscz/utils/api-descriptor";
import { ReplToolset, type ToolsetContext } from "@genesiscz/utils/repl/toolset";
import { z } from "zod";

declare global {
    var counterBootstraps: number | undefined;
}

/** A test toolset: counts its bootstraps per worker and appends "disposed" to a chosen log on dispose. */
export class CounterToolset extends ReplToolset {
    readonly api = defineApi({
        id: "counter",
        global: "counter",
        title: "Counter",
        summary: "Counts the preloads of this worker.",
        methods: [
            defineMethod({
                name: "logTo",
                params: z.object({ path: z.string() }),
                result: z.void(),
                doc: "Appends a line to path on dispose.",
                effect: "reversible",
                positional: ["path"],
            }),
        ],
    });
    private log?: string;

    async bootstrap(ctx: ToolsetContext): Promise<Record<string, unknown>> {
        globalThis.counterBootstraps = (globalThis.counterBootstraps ?? 0) + 1;
        await Bun.sleep(200);
        return {
            counter: {
                pid: process.pid,
                scratch: ctx.scratchDir,
                logTo: (path: string) => {
                    this.log = path;
                },
            },
        };
    }

    override async dispose(): Promise<void> {
        if (this.log) {
            appendFileSync(this.log, "disposed\n");
        }
    }
}

export class BrokenToolset extends CounterToolset {
    override async bootstrap(): Promise<Record<string, unknown>> {
        throw new Error("the native backend is missing");
    }
}
