import { join } from "node:path";
import { Conn, localDebuggerUrl, Page, targets } from "@app/chrome-devtools/lib/cdp";
import { acquireLock, type LockHandle } from "@genesiscz/utils/fs/lock";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { z } from "zod";
import { type Locator, safeUrl } from "./recipe";

export class Refusal extends Error {}
export interface DownloadEvidence {
    guid: string;
    filename: string;
    url: string;
    path: string;
    sha256?: string;
    at: number;
}
const downloadSchema = z.object({ guid: z.string(), suggestedFilename: z.string(), url: z.string() });
const probeSchema = z.object({
    count: z.number(),
    visible: z.boolean(),
    disabled: z.boolean(),
    password: z.boolean(),
    value: z.string(),
    x: z.number(),
    y: z.number(),
    url: z.string(),
    identity: z.boolean(),
    covered: z.boolean(),
});
export class BrowserSession {
    readonly downloads: DownloadEvidence[] = [];
    onDownload?: (entry: DownloadEvidence) => void;
    private completed = new Set<string>();
    private named = true;
    private configured = false;
    private routingLease?: LockHandle;
    private routingIdentity: string;
    readonly page: Page;
    readonly directory: string;
    private connection: Conn;
    private frameId: string;
    private captureWork: Promise<void>[] = [];
    private downloadWaiters = new Set<() => void>();
    constructor(options: {
        page: Page;
        connection: Conn;
        directory: string;
        frameId: string;
        browserIdentity: string;
    }) {
        this.page = options.page;
        this.connection = options.connection;
        this.directory = options.directory;
        this.frameId = options.frameId;
        this.routingIdentity = new Bun.CryptoHasher("sha256").update(options.browserIdentity).digest("hex");
        options.page.on((method, data) => {
            const frame = z.object({ id: z.string(), parentId: z.string().optional() }).safeParse(data.frame);
            if (method === "Page.frameNavigated" && frame.success && !frame.data.parentId) {
                this.frameId = frame.data.id;
            }
        });
        options.connection.on((method, data) => {
            if (
                method === "Browser.downloadWillBegin" &&
                data.frameId === this.frameId &&
                this.downloads.length < 200
            ) {
                const parsed = downloadSchema.safeParse(data);
                if (parsed.success) {
                    const entry = parsed.data;
                    this.downloads.push({
                        guid: entry.guid,
                        filename: entry.suggestedFilename,
                        url: entry.url,
                        path: join(this.directory, this.named ? entry.guid : entry.suggestedFilename),
                        at: Date.now(),
                    });
                }
            }
            if (method === "Browser.downloadProgress" && data.state === "completed" && typeof data.guid === "string") {
                const entry = this.downloads.find((download) => download.guid === data.guid);
                if (entry) {
                    this.completed.add(data.guid);
                    const file = Bun.file(entry.path);
                    this.captureWork.push(
                        (file.size <= 20_000_000
                            ? file.arrayBuffer()
                            : Promise.reject(new Refusal("Recording output exceeds 20 MB."))
                        )
                            .then((bytes) => {
                                entry.sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
                                this.onDownload?.(entry);
                            })
                            .catch((error) =>
                                logger.warn({ error }, "Recording download moved before its content could be read")
                            )
                    );
                }
                for (const wake of this.downloadWaiters) {
                    wake();
                }
            }
        });
    }
    async configureDownloads(
        options: { signal?: AbortSignal; named?: boolean; recordingAdmitted?: boolean } = {}
    ): Promise<void> {
        if (
            !options.recordingAdmitted &&
            (await this.page.evaluate("() => typeof window.__genesisRecordingCleanup === 'function'", {
                signal: options.signal,
            }))
        ) {
            throw new Refusal("A recording owns this tab. Stop it before replaying or changing download routing.");
        }
        options.signal?.throwIfAborted();
        if (this.routingLease) {
            throw new Refusal("This session already owns browser download routing.");
        }

        try {
            this.routingLease = await acquireLock(toolDataDir("show-once", "routing", this.routingIdentity));
        } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ELOCKED") {
                throw new Refusal("Another workflow owns this browser's download routing. Stop it first.");
            }
            throw error;
        }

        options.signal?.throwIfAborted();
        this.named = options.named ?? true;
        this.configured = true;
        await this.connection.send(
            "Browser.setDownloadBehavior",
            {
                behavior: this.named ? "allowAndName" : "allow",
                downloadPath: this.directory,
                eventsEnabled: true,
            },
            undefined,
            { signal: options.signal }
        );
    }
    async capturedDownloads(): Promise<DownloadEvidence[]> {
        await Promise.all(this.captureWork);
        return this.downloads.filter((entry) => this.completed.has(entry.guid));
    }
    async navigate(options: { url: string; signal?: AbortSignal }): Promise<void> {
        let loaderId: string | undefined;
        let finished = false;
        const seen = new Set<string>();
        let finish: (error?: Error) => void = () => {};
        const ready = new Promise<void>((resolveReady, reject) => {
            const abort = () => finish(new Error("Navigation cancelled; delivery may already have started."));
            const timer = setTimeout(
                () => finish(new Error("Navigation did not reach DOMContentLoaded before its deadline.")),
                10000
            );
            finish = (error) => {
                if (finished) {
                    return;
                }
                finished = true;
                clearTimeout(timer);
                options.signal?.removeEventListener("abort", abort);
                if (error) {
                    reject(error);
                } else {
                    resolveReady();
                }
            };
            this.page.on((method, data) => {
                if (
                    finished ||
                    method !== "Page.lifecycleEvent" ||
                    data.name !== "DOMContentLoaded" ||
                    data.frameId !== this.frameId ||
                    typeof data.loaderId !== "string"
                ) {
                    return;
                }
                seen.add(data.loaderId);
                if (loaderId && seen.has(loaderId)) {
                    finish();
                }
            });
            options.signal?.addEventListener("abort", abort, { once: true });
            if (options.signal?.aborted) {
                abort();
            }
        });
        void ready.catch((error) => logger.debug({ error }, "Navigation readiness stopped"));
        try {
            const result = z
                .object({ loaderId: z.string().optional(), errorText: z.string().optional() })
                .parse(await this.page.send("Page.navigate", { url: options.url }, { signal: options.signal }));
            if (result.errorText) {
                throw new Error(result.errorText);
            }
            loaderId = result.loaderId;
            if (!loaderId || seen.has(loaderId)) {
                finish();
            }
            await ready;
            await this.checkPage(options.url, options.signal);
        } catch (error) {
            finish(error instanceof Error ? error : new Error("Navigation failed."));
            throw error;
        }
    }

    async url(signal?: AbortSignal): Promise<string> {
        const value = await this.page.evaluate("() => location.href", { signal });
        if (typeof value !== "string") {
            throw new Refusal("The browser did not report its current URL.");
        }
        return value;
    }
    async checkPage(expected: string, signal?: AbortSignal): Promise<void> {
        const actual = await this.url(signal);
        if (actual !== expected) {
            throw new Refusal(`Stale page: expected ${expected}; observed ${actual}.`);
        }
    }
    private expression(locator: Locator, operation: string): string {
        const encoded = SafeJSON.stringify(locator, { strict: true });
        return `() => {
            const locator = ${encoded};
            const role = el => el.getAttribute('role') || ({BUTTON:'button',A:'link',SELECT:'combobox',TEXTAREA:'textbox'})[el.tagName] || (el.tagName === 'INPUT' ? ({checkbox:'checkbox',radio:'radio',submit:'button',button:'button'})[el.type] || 'textbox' : '');
            const name = el => (el.getAttribute('aria-label') || el.labels?.[0]?.textContent || el.innerText || el.getAttribute('alt') || '').trim().slice(0,160);
            const nodes = locator.kind === 'css' ? Array.from(document.querySelectorAll(locator.value)) : Array.from(document.querySelectorAll('*')).filter(el => locator.kind === 'testId' ? el.getAttribute('data-testid') === locator.value : role(el) === locator.value && name(el) === locator.name);
            const el = nodes[0];
            const rect = el?.getBoundingClientRect();
            const visible = !!el && !!rect && rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
            const disabled = !!el && (!!el.disabled || el.getAttribute('aria-disabled') === 'true');
            const identity = !locator.fingerprint || (!!el && el.tagName === locator.fingerprint.tag && role(el) === locator.fingerprint.role && name(el) === locator.fingerprint.name);

            const hit = rect ? document.elementFromPoint(rect.x + rect.width/2, rect.y + rect.height/2) : null;
            const covered = !!el && (el.closest('[inert]') !== null || !(hit === el || (hit && el.contains(hit))));
            const result = {count:nodes.length, visible, disabled, identity, covered, password:el?.type === 'password', value:typeof el?.value === 'string' ? el.value : '', x:rect ? rect.x + rect.width/2 : 0, y:rect ? rect.y + rect.height/2 : 0, url:location.href};
            ${operation}
        }`;
    }
    async probe(locator: Locator, signal?: AbortSignal) {
        return probeSchema.parse(await this.page.evaluate(this.expression(locator, "return result;"), { signal }));
    }
    async action(options: {
        locator: Locator;
        kind: "click" | "fill" | "select" | "press";
        value?: string;
        expectedUrl: string;
        secret?: boolean;
        signal?: AbortSignal;
        onDispatch: () => void;
    }): Promise<string> {
        const { locator, signal } = options;
        await this.checkPage(options.expectedUrl, signal);
        const before = await this.probe(locator, signal);
        if (before.count !== 1) {
            throw new Refusal(`Target resolved to ${before.count} matches; exactly one is required.`);
        }
        if (!before.identity) {
            throw new Refusal("Target identity differs from its recorded tag, role or name. Repair it explicitly.");
        }
        if (!before.visible || before.disabled) {
            throw new Refusal("Target is hidden or disabled.");
        }
        if (before.covered) {
            throw new Refusal("Target is covered, outside the viewport, or inert. Reveal it before replay.");
        }
        if (before.password && !options.secret) {
            throw new Refusal("Password fields require an explicit runtime secret input.");
        }
        const value = SafeJSON.stringify(options.value ?? "", { strict: true });
        const kind = SafeJSON.stringify(options.kind, { strict: true });
        const expected = SafeJSON.stringify(options.expectedUrl, { strict: true });
        const secret = options.secret === true;
        const operation = `if (nodes.length !== 1 || !visible || disabled || !identity || covered || (result.password && !${secret}) || location.href !== ${expected}) return {refused:true};
            const kind = ${kind}; const value = ${value}; el.scrollIntoView({block:'center'}); el.focus();
            if ((el.type === 'password' && !${secret}) || location.href !== ${expected}) return {refused:true};
            if (kind === 'click') el.click();
            if (kind === 'fill') {
                if (!['INPUT','TEXTAREA'].includes(el.tagName)) return {refused:true};
                const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                Object.getOwnPropertyDescriptor(proto,'value').set.call(el,value);
                el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));
            }
            if (kind === 'select') {
                if (el.tagName !== 'SELECT' || !Array.from(el.options).some(o => o.value === value)) return {refused:true};
                el.value = value; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));
            }
            return {refused:false};`;
        signal?.throwIfAborted();
        options.onDispatch();
        if (options.kind === "press") {
            await this.page.evaluate(
                this.expression(
                    locator,
                    `if(nodes.length !== 1 || !identity || !visible || disabled || covered || (result.password && !${secret}) || location.href !== ${expected}) throw Error('Target changed'); el.focus(); if (document.activeElement !== el || (el.type === 'password' && !${secret}) || location.href !== ${expected}) throw Error('Target changed'); return true;`
                ),
                { signal }
            );
            const keys: Record<string, { key: string; code: string; windowsVirtualKeyCode: number }> = {
                Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
                Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
                Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
                ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
                ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
                Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32 },
            };
            const key = keys[options.value ?? ""];
            if (!key) {
                throw new Refusal("Unsupported key.");
            }
            await this.page.send("Input.dispatchKeyEvent", { type: "keyDown", ...key }, { signal });
            await this.page.send("Input.dispatchKeyEvent", { type: "keyUp", ...key }, { signal });
            return "Key dispatched; the next checkpoint verifies its result.";
        }
        const result = z
            .object({ refused: z.boolean() })
            .parse(await this.page.evaluate(this.expression(locator, operation), { signal }));
        if (result.refused) {
            throw new Refusal("Target changed before action dispatch.");
        }
        if (options.kind === "fill" || options.kind === "select") {
            const after = await this.probe(locator, signal);
            if (after.count !== 1 || after.value !== options.value) {
                throw new Error("Input action was dispatched but readback differs.");
            }
            return "Exact value readback matched.";
        }
        return "Click dispatched; output verification follows in the recipe.";
    }
    async waitDownload(options: {
        after: number;
        filename: string;
        timeoutMs: number;
        signal?: AbortSignal;
    }): Promise<DownloadEvidence> {
        return new Promise((resolve, reject) => {
            const finish = (error?: Error, value?: DownloadEvidence) => {
                clearTimeout(timer);
                this.downloadWaiters.delete(check);
                options.signal?.removeEventListener("abort", abort);
                if (error) {
                    reject(error);
                } else if (value) {
                    resolve(value);
                }
            };
            const check = () => {
                const entries = this.downloads
                    .slice(options.after)
                    .filter((entry) => entry.filename === options.filename && this.completed.has(entry.guid));
                if (entries.length > 1) {
                    finish(new Refusal("Multiple completed downloads match the expected filename."));
                } else if (entries.length === 1) {
                    finish(undefined, entries[0]);
                }
            };
            const abort = () => finish(new Error("Download wait cancelled; the click may already have executed."));
            const timer = setTimeout(
                () => finish(new Error("Download did not complete before its deadline; do not retry blindly.")),
                options.timeoutMs
            );
            this.downloadWaiters.add(check);
            options.signal?.addEventListener("abort", abort, { once: true });
            if (options.signal?.aborted) {
                abort();
            } else {
                check();
            }
        });
    }
    async close(): Promise<void> {
        try {
            if (this.configured) {
                await this.connection.send("Browser.setDownloadBehavior", { behavior: "default" }, undefined, {
                    timeoutMs: 2000,
                });
            }
        } catch (error) {
            logger.warn({ error }, "Could not restore browser download behavior");
        } finally {
            this.configured = false;
            this.page.close();
            this.connection.close();
            await this.routingLease?.release();
            this.routingLease = undefined;
        }
    }
}
export async function connectSession(options: {
    port: number;
    targetId: string;
    directory: string;
    signal?: AbortSignal;
}): Promise<BrowserSession> {
    const list = await targets(options.port, { signal: options.signal });
    const target = list.find((entry) => entry.id === options.targetId && entry.type === "page");
    if (!target) {
        throw new Refusal("The explicitly selected browser tab no longer exists.");
    }
    if (target.url !== "about:blank") {
        safeUrl(target.url);
    }
    const response = await fetch(`http://127.0.0.1:${options.port}/json/version`, {
        signal: options.signal
            ? AbortSignal.any([options.signal, AbortSignal.timeout(5000)])
            : AbortSignal.timeout(5000),
    });
    const version = z.object({ webSocketDebuggerUrl: z.string() }).parse(await response.json());
    const browser = new Conn(localDebuggerUrl({ webSocketDebuggerUrl: version.webSocketDebuggerUrl }, options.port), {
        signal: options.signal,
    });
    const page = new Page(new Conn(localDebuggerUrl(target, options.port), { signal: options.signal }), target);
    try {
        for (const domain of ["Page", "Runtime"]) {
            await page.send(`${domain}.enable`, {}, { signal: options.signal });
        }
        await page.send("Page.setLifecycleEventsEnabled", { enabled: true }, { signal: options.signal });
        const frame = z
            .object({ frameTree: z.object({ frame: z.object({ id: z.string() }) }) })
            .parse(await page.send("Page.getFrameTree", {}, { signal: options.signal }));
        return new BrowserSession({
            page,
            connection: browser,
            directory: options.directory,
            frameId: frame.frameTree.frame.id,
            browserIdentity: localDebuggerUrl({ webSocketDebuggerUrl: version.webSocketDebuggerUrl }, options.port),
        });
    } catch (error) {
        page.close();
        browser.close();
        throw error;
    }
}
