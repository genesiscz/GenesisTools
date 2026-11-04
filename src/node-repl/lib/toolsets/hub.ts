import { hubPr, hubPrs } from "@app/hub/lib/prs";
import { defineApi, defineMethod } from "@genesiscz/utils/api-descriptor";
import { ReplToolset } from "@genesiscz/utils/repl/toolset";
import { z } from "zod";

const list = defineMethod({
    name: "prs",
    params: z.object({ paths: z.array(z.string()).min(1), limit: z.number().int().positive().default(30) }),
    result: z.unknown(),
    effect: "read",
    doc: "List open pull requests for local repositories.",
});
const open = defineMethod({
    name: "pr",
    params: z.object({ ref: z.string().min(1) }),
    result: z.unknown(),
    effect: "read",
    doc: "Read one pull request by its URL or repository reference.",
});

export class HubToolset extends ReplToolset {
    readonly api = defineApi({
        id: "hub",
        global: "hub",
        title: "Review hub",
        summary: "Read pull requests across repository hosts.",
        methods: [list, open],
    });

    async bootstrap(): Promise<Record<string, unknown>> {
        return {
            hub: {
                prs: (input: z.input<typeof list.params>) => hubPrs(list.params.parse(input)),
                pr: (input: z.input<typeof open.params>) => hubPr(open.params.parse(input)),
            },
        };
    }
}
