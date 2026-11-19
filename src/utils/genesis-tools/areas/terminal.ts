import { defineAction, defineArea } from "@genesiscz/utils/genesis-tools/actions/define";
import { Need } from "@genesiscz/utils/genesis-tools/capability/needs";
import { runVisibly } from "@genesiscz/utils/terminal/visible-run";
import { z } from "zod";
import { requestOutcomeSchema, requestSchema } from "./person/request";
import { presentInTerminal } from "./person/surfaces";

export const terminal = defineArea({
    area: "terminal",
    summary: "Run a command in a visible terminal",
    actions: {
        prompt: defineAction({
            summary: "Ask a person in the calling terminal",
            args: requestSchema,
            result: requestOutcomeSchema,
            native: { needs: [Need.person.terminal], run: presentInTerminal },
        }),
        runVisibly: defineAction({
            summary: "Open a terminal showing and running the exact command",
            args: z.object({ argv: z.array(z.string()).min(1) }),
            result: z.object({ opened: z.literal(true) }),
            native: {
                needs: [Need.platform.darwin, Need.person.display],
                run: (ctx) =>
                    runVisibly({
                        argv: ctx.args.argv,
                        timeoutMs: Math.min(15_000, ctx.timeoutMs),
                        signal: ctx.signal,
                    }),
            },
        }),
    },
});
declare module "@genesiscz/utils/genesis-tools/actions/registry" {
    interface GenesisToolsAreas {
        terminal: typeof terminal;
    }
}
