import type { TabDriver } from "@app/chrome-devtools/lib/tab-driver";
import { defineApi, defineMethod } from "@genesiscz/utils/api-descriptor";
import { ReplToolset } from "@genesiscz/utils/repl/toolset";
import { z } from "zod";

const connection = { port: z.number().int().min(1).max(65535) };
const tabs = defineMethod({
    name: "tabs",
    params: z.object(connection),
    result: z.unknown(),
    effect: "read",
    doc: "List tabs on a browser's CDP port.",
});
const open = defineMethod({
    name: "open",
    params: z.object({ ...connection, url: z.string().url() }),
    result: z.unknown(),
    effect: "reversible",
    doc: "Open a tab and wait for its load event.",
});
const evaluate = defineMethod({
    name: "evaluate",
    params: z.object({ ...connection, tabId: z.string(), source: z.string() }),
    result: z.unknown(),
    effect: "destructive",
    doc: "Evaluate JavaScript in a tab's main world; may change page or remote state.",
});
const navigate = defineMethod({
    name: "navigate",
    params: z.object({ ...connection, tabId: z.string(), url: z.string().url() }),
    result: z.boolean(),
    effect: "reversible",
    doc: "Navigate a tab and wait for its load event.",
});

export class BrowserToolset extends ReplToolset {
    readonly api = defineApi({
        id: "browser",
        global: "browser",
        title: "Browser",
        summary: "Inspect and operate browser tabs through Chrome DevTools.",
        methods: [tabs, open, evaluate, navigate],
    });
    private readonly drivers = new Map<number, TabDriver>();

    async bootstrap(): Promise<Record<string, unknown>> {
        // lazy: saves 14.8 ms cold import (tools ts imports lazy, 2026-11-05) — listing the toolsets loads no CDP driver
        const { createTabDriver } = await import("@app/chrome-devtools/lib/tab-driver");
        const driver = (port: number): TabDriver => {
            let current = this.drivers.get(port);

            if (!current) {
                current = createTabDriver(port);
                this.drivers.set(port, current);
            }

            return current;
        };
        return {
            browser: {
                tabs: (input: z.input<typeof tabs.params>) => driver(tabs.params.parse(input).port).tabs(),
                open: (input: z.input<typeof open.params>) => {
                    const options = open.params.parse(input);
                    return driver(options.port).open(options.url);
                },
                evaluate: (input: z.input<typeof evaluate.params>) => {
                    const options = evaluate.params.parse(input);
                    return driver(options.port).evaluate(options.tabId, options.source);
                },
                navigate: (input: z.input<typeof navigate.params>) => {
                    const options = navigate.params.parse(input);
                    return driver(options.port).navigate(options.tabId, options.url);
                },
            },
        };
    }

    override async dispose(): Promise<void> {
        for (const driver of this.drivers.values()) {
            driver.close();
        }

        this.drivers.clear();
    }
}
