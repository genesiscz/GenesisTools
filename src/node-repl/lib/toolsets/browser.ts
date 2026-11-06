import { join } from "node:path";
import type { TabDriver } from "@app/chrome-devtools/lib/tab-driver";
import { defineApi, defineMethod } from "@genesiscz/utils/api-descriptor";
import { logger } from "@genesiscz/utils/logger";
import { ReplToolset, type ToolsetContext } from "@genesiscz/utils/repl/toolset";
import { z } from "zod";

const { log } = logger.scoped("repl-browser");

const connection = { port: z.number().int().min(1).max(65535) };
const tabInfo = "{ id, url, title }";
const userBrowser =
    "On a browser the user also uses, the tab changes in front of them; start your own with --remote-debugging-port and --user-data-dir for work they should not see.";
const tabs = defineMethod({
    name: "tabs",
    params: z.object(connection),
    result: z.unknown(),
    resultName: `${tabInfo}[]`,
    effect: "read",
    doc: "List tabs on a browser's CDP port.",
});
const open = defineMethod({
    name: "open",
    params: z.object({ ...connection, url: z.string().url() }),
    result: z.unknown(),
    resultName: `${tabInfo} plus loaded: false when the load event did not come within 20 s`,
    effect: "reversible",
    reaches: ["user"],
    doc: `Open a tab on the url and wait for its load event. A url that does not load (no such host, refused) is refused with the browser's reason, and the tab is closed. ${userBrowser}`,
});
const evaluate = defineMethod({
    name: "evaluate",
    params: z.object({ ...connection, tabId: z.string(), source: z.string() }),
    result: z.unknown(),
    effect: "destructive",
    doc: "Evaluate JavaScript in a tab's main world and answer its value; may change page or remote state. `source` is an expression (`document.title`, `(1 + 2) * 3`) or a function, which is called (`() => …`, `async () => …`, `function () { … }`); a promise is awaited. A bare top-level `await` is not an expression: wrap it in `async () => { … }`.",
});
const navigate = defineMethod({
    name: "navigate",
    params: z.object({ ...connection, tabId: z.string(), url: z.string().url() }),
    result: z.boolean(),
    resultName: "true when the load event came, false after 20 s without it",
    effect: "reversible",
    reaches: ["user"],
    doc: `Navigate a tab and wait for its load event; a url that does not load is refused with the browser's reason. ${userBrowser}`,
});
const close = defineMethod({
    name: "close",
    params: z.object({ ...connection, tabId: z.string() }),
    result: z.unknown(),
    resultName: "{ closed: tabId }",
    effect: "destructive",
    reaches: ["user"],
    doc: `Close a tab, such as one open() made. Its page state is gone. ${userBrowser}`,
});
const screenshot = defineMethod({
    name: "screenshot",
    params: z.object({ ...connection, tabId: z.string(), fullPage: z.boolean().optional() }),
    result: z.unknown(),
    resultName: "{ path }",
    effect: "reversible",
    doc: "A PNG of the tab's viewport (fullPage: the whole page) in this worker's scratch folder; `await show(path)` returns it to the model.",
});

/**
 * A call's error with the port named when nothing answers on it. fetch says only "Unable to connect. Is the computer
 * able to access the url?", which names neither the port nor how to start a browser there (NR26).
 */
export function browserError(port: number, error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error);

    if (!/Unable to connect|ECONNREFUSED|ConnectionRefused|fetch failed/i.test(message)) {
        return error instanceof Error ? error : new Error(message);
    }

    return new Error(
        `no browser answers on CDP port ${port} (http://127.0.0.1:${port}); start one with --remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`
    );
}

export class BrowserToolset extends ReplToolset {
    readonly api = defineApi({
        id: "browser",
        global: "browser",
        title: "Browser",
        summary:
            "Open, read, navigate, screenshot and close browser tabs through Chrome DevTools; tools chrome-devtools has click, fill and snapshot.",
        methods: [tabs, open, evaluate, navigate, close, screenshot],
    });
    private readonly drivers = new Map<number, TabDriver>();
    private shots = 0;

    async bootstrap(ctx: ToolsetContext): Promise<Record<string, unknown>> {
        // lazy: saves 14.8 ms cold import (tools ts imports lazy, 2026-11-05) — listing the toolsets loads no CDP driver
        const { createTabDriver } = await import("@app/chrome-devtools/lib/tab-driver");
        const { Conn, localDebuggerUrl, Page, targets } = await import("@app/chrome-devtools/lib/cdp");
        const { closeTab } = await import("@app/chrome-devtools/lib/tabs");
        const driver = (port: number): TabDriver => {
            let current = this.drivers.get(port);

            if (!current) {
                current = createTabDriver(port);
                this.drivers.set(port, current);
            }

            return current;
        };
        const onPort = async <T>(port: number, call: () => Promise<T>): Promise<T> => {
            try {
                return await call();
            } catch (error) {
                throw browserError(port, error);
            }
        };
        return {
            browser: {
                tabs: (input: z.input<typeof tabs.params>) => {
                    const { port } = tabs.params.parse(input);
                    return onPort(port, () => driver(port).tabs());
                },
                // A blank tab first, then a navigation: Page.navigate answers the browser's errorText
                // ("net::ERR_NAME_NOT_RESOLVED"), where a tab made on the url answered { title: "" } (NR26).
                open: (input: z.input<typeof open.params>) => {
                    const options = open.params.parse(input);
                    return onPort(options.port, async () => {
                        const blank = await driver(options.port).open("about:blank");
                        const loaded = await driver(options.port)
                            .navigate(blank.id, options.url)
                            .catch(async (error: unknown) => {
                                await closeTab(options.port, blank.id).catch((closeError: unknown) => {
                                    log.debug({ error: closeError, tabId: blank.id }, "a failed tab was not closed");
                                });
                                throw error;
                            });
                        const tab = (await driver(options.port).tabs()).find((one) => one.id === blank.id);
                        return {
                            id: blank.id,
                            url: tab?.url ?? options.url,
                            title: tab?.title ?? "",
                            ...(loaded ? {} : { loaded }),
                        };
                    });
                },
                evaluate: (input: z.input<typeof evaluate.params>) => {
                    const options = evaluate.params.parse(input);
                    return onPort(options.port, () => driver(options.port).evaluate(options.tabId, options.source));
                },
                navigate: (input: z.input<typeof navigate.params>) => {
                    const options = navigate.params.parse(input);
                    return onPort(options.port, () => driver(options.port).navigate(options.tabId, options.url));
                },
                close: (input: z.input<typeof close.params>) => {
                    const options = close.params.parse(input);
                    return onPort(options.port, async () => {
                        await closeTab(options.port, options.tabId);
                        return { closed: options.tabId };
                    });
                },
                screenshot: (input: z.input<typeof screenshot.params>) => {
                    const options = screenshot.params.parse(input);
                    return onPort(options.port, async () => {
                        const target = (await targets(options.port)).find((one) => one.id === options.tabId);

                        if (!target) {
                            throw new Error(
                                `no tab ${options.tabId} on port ${options.port}; browser.tabs() lists them`
                            );
                        }

                        const page = new Page(new Conn(localDebuggerUrl(target, options.port)), target);

                        try {
                            const path = join(ctx.scratchDir, `browser-${++this.shots}.png`);
                            return { path: await page.screenshot(path, options.fullPage ?? false) };
                        } finally {
                            page.close();
                        }
                    });
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
