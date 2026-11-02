import { logger } from "@genesiscz/utils/logger";
import { WazeClient } from "./client";
import { BrowserTabTransport } from "./session";
import { WazeStore } from "./store";

const { log } = logger.scoped("waze-context");

export interface WazeContextOptions {
    port?: number;
    /** Leave the live-map tab open for the next run (its id is kept in `~/.genesis-tools/waze/tab.json`). */
    keepTab?: boolean;
}

/**
 * What an operation needs, opened lazily: the browser tab only when an operation talks to Waze, the store only when it
 * records or reads history. `close()` closes the tab this context opened (unless `keepTab`) and the store.
 */
export class WazeContext {
    private clientPromise: Promise<WazeClient> | undefined;
    private storeInstance: WazeStore | undefined;
    private storeReadOnly = false;

    constructor(readonly options: WazeContextOptions = {}) {}

    private opened: WazeClient | undefined;

    /** The open client, without opening one (undefined until an operation talked to Waze). */
    openedClient(): WazeClient | undefined {
        return this.opened;
    }

    client(): Promise<WazeClient> {
        this.clientPromise ??= BrowserTabTransport.open({
            port: this.options.port,
            keepTab: this.options.keepTab,
        }).then((transport) => {
            this.opened = new WazeClient(transport);
            return this.opened;
        });
        // A failed open must not stay cached: the next call (an MCP retry after the user starts Brave) tries again.
        this.clientPromise.catch((error: unknown) => {
            log.debug({ error }, "waze transport open failed");
            this.clientPromise = undefined;
        });
        return this.clientPromise;
    }

    store(): WazeStore {
        if (this.storeReadOnly) {
            this.storeInstance?.close();
            this.storeInstance = undefined;
            this.storeReadOnly = false;
        }

        this.storeInstance ??= WazeStore.open();
        return this.storeInstance;
    }

    /** The store opened read-only, or undefined when nothing was recorded yet (never creates the file). */
    readStore(): WazeStore | undefined {
        if (!this.storeInstance) {
            this.storeInstance = WazeStore.openReadOnly();
            this.storeReadOnly = this.storeInstance !== undefined;
        }

        return this.storeInstance;
    }

    async close(): Promise<void> {
        const pending = this.clientPromise;
        this.clientPromise = undefined;
        this.opened = undefined;
        if (pending) {
            try {
                await (await pending).transport.close();
            } catch (error) {
                log.debug({ error }, "waze transport close after a failed open");
            }
        }

        this.storeInstance?.close();
        this.storeInstance = undefined;
        this.storeReadOnly = false;
    }
}
