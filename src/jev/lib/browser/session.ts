import { connectDevtoolsClient, toolText } from "@genesiscz/utils/devtools/mcp-client";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";

const prof = profiler.scope("jev-browser");
const { log } = logger.scoped("jev-browser");

/**
 * A session left open holds a `chrome-devtools-mcp` child process, and that child keeps the whole
 * Bun process alive: `beforeExit` never fires, so a caller that forgets `close()` hangs forever
 * instead of printing its result. This deadline closes an idle session so the worst case is a late
 * exit rather than no exit. It is a safety net; the caller still owns `close()`.
 */
const IDLE_CLOSE_MS = 20_000;

export interface BrowserMcp {
    callTool(name: string, args?: Record<string, unknown>): Promise<unknown>;
    toolText(result: unknown): string;
    /**
     * Counts connections. A caller that selected a page compares this against the value it saw
     * when it selected, and re-selects when the number moved: a reconnected server has forgotten
     * which page it was pointed at, and acting on its own choice is how a loop reaches a stranger's
     * tab.
     */
    connectionId(): number;
    close(): Promise<void>;
}

/**
 * One door to chrome-devtools-mcp for a whole goal run.
 *
 * `callTool` from `@app/chrome-devtools/lib/mcp` spawns a fresh `chrome-devtools-mcp` process per
 * call and closes it again, so the page a `select_page` picked is gone by the time the next call
 * runs: every snapshot then describes whatever page the new server chose on its own. Measured on
 * 2026-09-18 against Brave with 56 tabs open — `select_page` on the fixture tab followed by a
 * separate `take_snapshot` returned a different site. One client for the run is what makes page
 * targeting real.
 */
export function createMcpSession(options: { port: number; cdpUrl?: string; idleMs?: number }): BrowserMcp {
    const cdpUrl = options.cdpUrl ?? `http://127.0.0.1:${options.port}`;
    const idleMs = options.idleMs ?? IDLE_CLOSE_MS;
    let client: Awaited<ReturnType<typeof connectDevtoolsClient>> | undefined;
    let connections = 0;
    let idle: ReturnType<typeof setTimeout> | undefined;

    const closeClient = async () => {
        if (idle) {
            clearTimeout(idle);
            idle = undefined;
        }

        if (!client) {
            return;
        }

        const open = client;
        client = undefined;
        try {
            await open.close();
            log.debug({ cdpUrl }, "chrome-devtools-mcp session closed");
        } catch (error) {
            log.warn({ error, cdpUrl }, "chrome-devtools-mcp session did not close cleanly");
        }
    };

    const armIdleClose = () => {
        if (idle) {
            clearTimeout(idle);
        }

        idle = setTimeout(() => {
            log.info({ cdpUrl, idleMs }, "closing an idle chrome-devtools-mcp session");
            void closeClient();
        }, idleMs);
    };

    const connect = async () => {
        if (!client) {
            log.info({ cdpUrl, connection: connections + 1 }, "opening a chrome-devtools-mcp session");
            client = await prof.measureAsync("connect", () =>
                connectDevtoolsClient({ cdpUrl, clientName: "genesis-jev-browser" })
            );
            connections += 1;
        }

        return client;
    };

    return {
        async callTool(name: string, args: Record<string, unknown> = {}) {
            // Disarm first: a `take_snapshot` on a browser with sixty tabs took 26 s here, and an
            // idle close that fires mid-call kills the transport under it ("Connection closed").
            if (idle) {
                clearTimeout(idle);
                idle = undefined;
            }

            const connected = await connect();
            log.debug({ tool: name, args, cdpUrl }, "chrome-devtools-mcp call");
            try {
                return await prof.measureAsync(`mcp-${name}`, () => connected.callTool({ name, arguments: args }));
            } finally {
                armIdleClose();
            }
        },
        toolText,
        connectionId() {
            return connections;
        },
        close: closeClient,
    };
}
