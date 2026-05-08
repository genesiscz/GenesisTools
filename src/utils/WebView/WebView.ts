import crypto from "node:crypto";
import { writeFileSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { getLogger } from "@app/logger";
import { AsyncOpQueue, withTimeout } from "@app/utils/async";
import { requireHeadlessBrowser } from "@app/utils/bun";
import { SafeJSON } from "@app/utils/json";
import { Storage } from "@app/utils/storage/storage";
import type { Logger } from "pino";
import { WebViewError, WebViewEvaluateError, WebViewNavigationError, WebViewTimeoutError } from "./errors";
import type {
    DataStoreConfig,
    EvaluateOptions,
    NavigateOptions,
    ScreenshotOptions,
    ScreenshotResult,
    WebViewBackend,
    WebViewOptions,
} from "./types";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 900;

let exitHandlerRegistered = false;

function ensureExitHandler(): void {
    if (exitHandlerRegistered) {
        return;
    }

    exitHandlerRegistered = true;
    process.on("exit", () => {
        try {
            (Bun as unknown as { WebView: { closeAll(): void } }).WebView.closeAll();
        } catch {
            // best-effort in exit handler
        }
    });
}

function generateInstanceId(): string {
    return crypto.randomBytes(4).toString("hex");
}

function resolveBackend(requested?: WebViewBackend): WebViewBackend {
    if (requested) {
        return requested;
    }

    return platform() === "darwin" ? "webkit" : "chrome";
}

function resolveDataStore(opts: WebViewOptions): DataStoreConfig {
    if (opts.dataStore) {
        return opts.dataStore;
    }

    if (opts.toolName && opts.profileKey) {
        const storage = new Storage(opts.toolName);
        const directory = join(storage.getBaseDir(), "webview-profile", opts.profileKey);
        return { directory };
    }

    return "ephemeral";
}

type BunWebViewInstance = {
    navigate(url: string): void;
    goBack(): void;
    goForward(): void;
    reload(): void;
    evaluate(expression: string): Promise<unknown>;
    screenshot(options?: { format?: string; quality?: number; encoding?: string }): Promise<unknown>;
    click(target: { x: number; y: number } | string): Promise<void>;
    type(text: string): Promise<void>;
    press(key: string): Promise<void>;
    scroll(dx: number, dy: number): Promise<void>;
    scrollTo(selector: string): Promise<void>;
    resize(width: number, height: number): Promise<void>;
    cdp(method: string, params?: Record<string, unknown>): Promise<unknown>;
    close(): void;
    onNavigated: (() => void) | undefined;
    onNavigationFailed: ((err: unknown) => void) | undefined;
};

type BunWebViewConstructorOptions = {
    headless: boolean;
    width?: number;
    height?: number;
    url?: string;
    backend?: string;
    dataStore?: DataStoreConfig;
    console?: (level: string, ...args: unknown[]) => void;
};

export class WebView {
    readonly instanceId: string;
    readonly log: Logger;

    private bwv: BunWebViewInstance;
    private evalQueue: AsyncOpQueue;
    private defaultTimeoutMs: number;
    private backend: WebViewBackend;
    private _closed = false;
    private navigating = false;

    constructor(options: WebViewOptions = {}) {
        requireHeadlessBrowser();
        ensureExitHandler();

        this.instanceId = generateInstanceId();
        this.defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.backend = resolveBackend(options.backend);
        this.log = (options.logger ?? getLogger()).child({
            component: "WebView",
            instance: this.instanceId,
        });
        this.evalQueue = new AsyncOpQueue(`WebView.evaluate:${this.instanceId}`);

        const BunWebView = (
            Bun as unknown as {
                WebView: new (opts: BunWebViewConstructorOptions) => BunWebViewInstance;
            }
        ).WebView;

        const bunOptions: BunWebViewConstructorOptions = {
            headless: true,
            width: options.width ?? DEFAULT_WIDTH,
            height: options.height ?? DEFAULT_HEIGHT,
            backend: this.backend,
            dataStore: resolveDataStore(options),
            console: options.consolePipe
                ? (level: string, ...args: unknown[]) => {
                      const msg = args.map(String).join(" ");
                      const pageLog = this.log.child({ pageConsole: true });

                      if (level === "error") {
                          pageLog.error({ msg }, "page console");
                      } else if (level === "warn") {
                          pageLog.warn({ msg }, "page console");
                      } else {
                          pageLog.debug({ msg, level }, "page console");
                      }
                  }
                : undefined,
        };

        if (options.url) {
            bunOptions.url = options.url;
        }

        this.bwv = new BunWebView(bunOptions);
        this.log.debug("created");
    }

    get closed(): boolean {
        return this._closed;
    }

    private assertOpen(method: string): void {
        if (this._closed) {
            throw new WebViewError(`Cannot call ${method}() on a closed WebView instance`, this.instanceId);
        }
    }

    private async withAbort<T>(
        signal: AbortSignal | undefined,
        operation: string,
        timeoutMs: number,
        fn: () => Promise<T>
    ): Promise<T> {
        if (signal?.aborted) {
            throw new WebViewError(`${operation} aborted before start`, this.instanceId);
        }

        const timeoutError = new WebViewTimeoutError(operation, timeoutMs, this.instanceId);
        const mainPromise = withTimeout(fn(), timeoutMs, timeoutError);

        if (!signal) {
            return mainPromise;
        }

        return Promise.race([
            mainPromise,
            new Promise<T>((_, reject) => {
                signal.addEventListener(
                    "abort",
                    () => {
                        reject(new WebViewError(`${operation} aborted`, this.instanceId));
                    },
                    { once: true }
                );
            }),
        ]);
    }

    navigate(url: string, options: NavigateOptions = {}): Promise<void> {
        this.assertOpen("navigate");

        if (this.navigating) {
            throw new WebViewError("navigate() called while a navigation is already in progress", this.instanceId);
        }

        const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;

        return this.withAbort(options.signal, `navigate(${url})`, timeoutMs, () => {
            return new Promise<void>((resolve, reject) => {
                this.navigating = true;
                const prevNavigated = this.bwv.onNavigated;
                const prevFailed = this.bwv.onNavigationFailed;

                const cleanup = () => {
                    this.navigating = false;
                    this.bwv.onNavigated = prevNavigated;
                    this.bwv.onNavigationFailed = prevFailed;
                };

                this.bwv.onNavigated = () => {
                    cleanup();
                    this.log.debug({ url }, "navigated");
                    resolve();
                };

                this.bwv.onNavigationFailed = (err: unknown) => {
                    cleanup();
                    reject(new WebViewNavigationError(url, this.instanceId, err));
                };

                this.bwv.navigate(url);
            });
        });
    }

    private queuedEvaluate<T>(expression: string): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            this.evalQueue.enqueue(async () => {
                try {
                    const result = (await this.bwv.evaluate(expression)) as T;
                    resolve(result);
                } catch (err) {
                    reject(new WebViewEvaluateError(expression, this.instanceId, err));
                }
            });
        });
    }

    evaluate<T = unknown>(expression: string, options: EvaluateOptions = {}): Promise<T> {
        this.assertOpen("evaluate");
        const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
        return this.withAbort(options.signal, `evaluate(${expression.slice(0, 40)})`, timeoutMs, () =>
            this.queuedEvaluate<T>(expression)
        );
    }

    async screenshot(options: ScreenshotOptions = {}): Promise<ScreenshotResult> {
        this.assertOpen("screenshot");
        const format = options.format ?? "png";
        const encoding = options.encoding ?? "base64";
        const result = await this.bwv.screenshot({ format, quality: options.quality, encoding });
        return { data: result as string | Buffer | SharedArrayBuffer, format, encoding };
    }

    async screenshotToFile(filePath: string, options: ScreenshotOptions = {}): Promise<void> {
        this.assertOpen("screenshotToFile");
        const result = await this.screenshot({ ...options, encoding: "binary" });
        writeFileSync(filePath, result.data as Buffer);
        this.log.debug({ filePath }, "screenshot saved");
    }

    async waitForSelector(
        selector: string,
        options: { timeoutMs?: number; signal?: AbortSignal; pollMs?: number } = {}
    ): Promise<void> {
        this.assertOpen("waitForSelector");
        const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
        const pollMs = options.pollMs ?? 100;

        return this.withAbort(options.signal, `waitForSelector(${selector})`, timeoutMs, async () => {
            while (true) {
                const found = await this.queuedEvaluate<boolean>(
                    `!!document.querySelector(${SafeJSON.stringify(selector)})`
                );

                if (found) {
                    return;
                }

                await Bun.sleep(pollMs);
            }
        });
    }

    async click(target: { x: number; y: number } | string): Promise<void> {
        this.assertOpen("click");
        await this.bwv.click(target);
    }

    async type(text: string): Promise<void> {
        this.assertOpen("type");
        await this.bwv.type(text);
    }

    async press(key: string): Promise<void> {
        this.assertOpen("press");
        await this.bwv.press(key);
    }

    async scroll(dx: number, dy: number): Promise<void> {
        this.assertOpen("scroll");
        await this.bwv.scroll(dx, dy);
    }

    async scrollTo(selector: string): Promise<void> {
        this.assertOpen("scrollTo");
        await this.bwv.scrollTo(selector);
    }

    async resize(width: number, height: number): Promise<void> {
        this.assertOpen("resize");
        await this.bwv.resize(width, height);
    }

    async cdp(method: string, params?: Record<string, unknown>): Promise<unknown> {
        this.assertOpen("cdp");

        if (this.backend !== "chrome") {
            throw new WebViewError("cdp() is only available when backend is 'chrome'", this.instanceId);
        }

        return this.bwv.cdp(method, params);
    }

    async goBack(): Promise<void> {
        this.assertOpen("goBack");
        this.bwv.goBack();
    }

    async goForward(): Promise<void> {
        this.assertOpen("goForward");
        this.bwv.goForward();
    }

    async reload(): Promise<void> {
        this.assertOpen("reload");
        this.bwv.reload();
    }

    close(): void {
        if (this._closed) {
            return;
        }

        this._closed = true;
        this.log.debug("closed");

        try {
            this.bwv.close();
        } catch {
            // already closed
        }
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await this.evalQueue.flush();
        this.close();
    }
}
