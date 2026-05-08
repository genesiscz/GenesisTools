import type { Logger } from "pino";
import { getLogger } from "@app/logger";
import { WebViewError } from "./errors";
import type { WebViewOptions } from "./types";
import { WebView } from "./WebView";

export interface WebViewPoolOptions {
    size?: number;
    factory?: () => WebView;
    instanceOptions?: WebViewOptions;
}

export class WebViewPool {
    private readonly maxSize: number;
    private readonly factory: () => WebView;
    private readonly log: Logger;
    private idleInstances: WebView[] = [];
    private _inUseCount = 0;
    private waiting: Array<(wv: WebView) => void> = [];
    private draining = false;

    constructor(options: WebViewPoolOptions = {}) {
        this.maxSize = options.size ?? 3;
        this.log = getLogger().child({ component: "WebViewPool" });
        this.factory = options.factory ?? (() => new WebView(options.instanceOptions));
    }

    get idle(): number {
        return this.idleInstances.length;
    }

    get inUse(): number {
        return this._inUseCount;
    }

    acquire(signal?: AbortSignal): Promise<WebView> {
        if (this.draining) {
            return Promise.reject(
                new WebViewError("WebViewPool is draining -- cannot acquire new instances", "pool"),
            );
        }

        if (signal?.aborted) {
            return Promise.reject(new WebViewError("acquire() aborted before start", "pool"));
        }

        const popped = this.idleInstances.pop();

        if (popped) {
            this._inUseCount++;
            this.log.debug({ idle: this.idle, inUse: this._inUseCount }, "acquired from idle");
            return Promise.resolve(popped);
        }

        if (this._inUseCount < this.maxSize) {
            const wv = this.factory();
            this._inUseCount++;
            this.log.debug({ idle: this.idle, inUse: this._inUseCount }, "created new instance");
            return Promise.resolve(wv);
        }

        return new Promise<WebView>((resolve, reject) => {
            let settled = false;

            const waiter = (wv: WebView) => {
                if (settled) {
                    return;
                }

                settled = true;
                this._inUseCount++;
                resolve(wv);
            };

            this.waiting.push(waiter);

            if (signal) {
                signal.addEventListener(
                    "abort",
                    () => {
                        if (settled) {
                            return;
                        }

                        settled = true;
                        const idx = this.waiting.indexOf(waiter);

                        if (idx !== -1) {
                            this.waiting.splice(idx, 1);
                        }

                        reject(new WebViewError("acquire() aborted while waiting", "pool"));
                    },
                    { once: true },
                );
            }
        });
    }

    release(wv: WebView): void {
        const instance = wv.closed ? this.factory() : wv;

        const waiter = this.waiting.shift();

        if (waiter) {
            this._inUseCount--;
            this.log.debug({ waiting: this.waiting.length }, "handed to waiter");
            waiter(instance);
            return;
        }

        this._inUseCount--;
        this.idleInstances.push(instance);
        this.log.debug({ idle: this.idle, inUse: this._inUseCount }, "released to idle");
    }

    async withInstance<T>(fn: (wv: WebView) => Promise<T>, signal?: AbortSignal): Promise<T> {
        const wv = await this.acquire(signal);

        try {
            return await fn(wv);
        } finally {
            this.release(wv);
        }
    }

    async drain(): Promise<void> {
        this.draining = true;
        this.log.debug({ inUse: this._inUseCount }, "draining pool");

        while (this._inUseCount > 0) {
            await Bun.sleep(50);
        }

        for (const wv of this.idleInstances) {
            wv.close();
        }

        this.idleInstances = [];
        this.log.debug("drained");
    }
}
