import { defineAction, defineArea } from "@genesiscz/utils/genesis-tools/actions/define";
import { appBuilder } from "@genesiscz/utils/genesis-tools/app-builder";
import { APP_PART_IDS } from "@genesiscz/utils/genesis-tools/capability/generated/app-surface";
import { Need } from "@genesiscz/utils/genesis-tools/capability/needs";
import { z } from "zod";

const helloResult = z.object({
    protocol: z.number(),
    bundleId: z.string(),
    version: z.string(),
    build: z.string(),
    methods: z.array(z.string()),
});

/** GenesisTools.app itself: what the installed build answers, and its build. `ctx.app.rpc` is the one-shot door. */
export const app = defineArea({
    area: "app",
    summary: "GenesisTools.app: what the installed build answers, and building it",
    actions: {
        hello: defineAction({
            summary: "Ask the installed app for its protocol, version and the --rpc methods it answers",
            args: z.object({}),
            result: helloResult,
            native: {
                needs: [Need.platform.darwin, Need.app.installed],
                run: async (ctx) => {
                    const reply = await ctx.app.rpc("rpc.hello");

                    if (!reply.ok) {
                        return ctx.pass(`rpc.hello failed: ${reply.error.code}: ${reply.error.message}`);
                    }

                    return helloResult.parse(reply.result);
                },
            },
        }),
        build: defineAction({
            summary: "Build and install GenesisTools.app, with one more part when one is named",
            args: z.object({ part: z.enum(APP_PART_IDS).optional() }),
            result: z.object({ built: z.literal(true), part: z.enum(APP_PART_IDS).nullable() }),
            native: {
                needs: [Need.platform.darwin],
                run: async (ctx) => {
                    const builder = appBuilder();

                    if (!builder) {
                        return ctx.pass("the app builder is not registered in this process");
                    }

                    const part = ctx.args.part ?? null;
                    await builder.build(part);
                    return { built: true as const, part };
                },
            },
            manual: (args) => `tools macos permissions build${args.part ? ` --add-part ${args.part}` : ""}`,
        }),
    },
});

declare module "@genesiscz/utils/genesis-tools/actions/registry" {
    interface GenesisToolsAreas {
        app: typeof app;
    }
}
