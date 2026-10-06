import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { Conn, localDebuggerUrl, targets } from "./cdp";

const log = logger.child({ component: "chrome-devtools:action-recording" });
export type BrowserLocator = {
    kind: "testId" | "role" | "css";
    value: string;
    name?: string;
    fingerprint?: { tag: string; role: string; name: string };
};
export interface BrowserAction {
    id: string;
    kind: "click" | "fill" | "select" | "press" | "navigate";
    locator?: BrowserLocator;
    value?: string;
    url?: string;
    sourceUrl?: string;
    excluded: boolean;
    at: number;
}
export interface BrowserEvidence {
    id: string;
    kind: "console" | "network" | "navigation" | "warning";
    text: string;
    excluded: boolean;
    at: number;
}
export interface ActionRecordingSnapshot {
    initialUrl: string;
    actions: BrowserAction[];
    evidence: BrowserEvidence[];
}
export interface ActionRecording {
    snapshot(): ActionRecordingSnapshot;
    stop(): Promise<ActionRecordingSnapshot>;
}

export function redactBrowserText(text: string): string {
    return text
        .replace(/(bearer\s+)[\w.+/=:-]+/gi, "$1[redacted]")
        .replace(/([?&](?:token|key|secret|password|code|auth)[^=]*=)[^&#\s]*/gi, "$1[redacted]")
        .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, "$1[redacted]@")
        .replace(
            /(\b(?:api[_ -]?key|password|passwd|secret|token|credential|authorization)["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi,
            "$1[redacted]"
        )
        .slice(0, 4000);
}

export function validBrowserLocator(value: unknown): value is BrowserLocator {
    if (!value || typeof value !== "object") {
        return false;
    }

    const item = value as Record<string, unknown>;
    if (item.fingerprint !== undefined) {
        if (!item.fingerprint || typeof item.fingerprint !== "object") {
            return false;
        }
        const fingerprint = item.fingerprint as Record<string, unknown>;
        if (
            ![fingerprint.tag, fingerprint.role, fingerprint.name].every(
                (part) => typeof part === "string" && part.length < 1000
            )
        ) {
            return false;
        }
    }
    return (
        ["testId", "role", "css"].includes(String(item.kind)) &&
        typeof item.value === "string" &&
        item.value.length > 0 &&
        item.value.length < 1000 &&
        (item.name === undefined || typeof item.name === "string")
    );
}

const BINDING = "__genesisRecordAction";
export const ACTION_RECORDING_SCRIPT = `(() => {
    const owner = '__GENESIS_RECORDING_OWNER__';
    if (window.__genesisRecordingOwner && window.__genesisRecordingOwner !== owner) throw new Error('Another recording owns this tab.');
    if (window.__genesisRecordingCleanup) {
        if (window.__genesisRecordingOwner === owner) return true;
        throw new Error('A stale recorder marker requires a tab reload.');
    }
    window.__genesisRecordingOwner = owner;
    const send = event => window.${BINDING}(JSON.stringify(event));
    const name = el => (el.getAttribute('aria-label') || el.labels?.[0]?.textContent || el.innerText || el.getAttribute('alt') || '').trim().slice(0, 160);
    const role = el => el.getAttribute('role') || ({BUTTON:'button',A:'link',SELECT:'combobox',TEXTAREA:'textbox'})[el.tagName] || (el.tagName === 'INPUT' ? ({checkbox:'checkbox',radio:'radio',submit:'button',button:'button'})[el.type] || 'textbox' : '');
    const locate = el => {
        const testId = el.getAttribute('data-testid');
        if (testId && document.querySelectorAll('[data-testid="' + CSS.escape(testId) + '"]').length === 1) return {kind:'testId',value:testId};
        const r = role(el), n = name(el);
        if (r && n && [...document.querySelectorAll('*')].filter(x => role(x) === r && name(x) === n).length === 1) return {kind:'role',value:r,name:n};
        if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) return {kind:'css',value:'#' + CSS.escape(el.id)};
        const parts = []; let node = el;
        while (node && node !== document.documentElement) {
            let part = node.tagName.toLowerCase();
            if (node.parentElement) part += ':nth-of-type(' + ([...node.parentElement.children].filter(x => x.tagName === node.tagName).indexOf(node) + 1) + ')';
            parts.unshift(part); node = node.parentElement;
        }
        const selector = parts.join(' > ');
        return selector && document.querySelectorAll(selector).length === 1 ? {kind:'css',value:selector} : null;
    };
    const handler = event => {
        if (!event.isTrusted || !(event.target instanceof Element)) return;
        if (window.top !== window) { send({warning:'Frame actions require a manually adapted Playwright frame locator and were omitted.'}); return; }
        if (event.type === 'click' && event.detail === 0) return;
        const el = event.type === 'click' ? event.target.closest('button,a,input,select,textarea,[role],[data-testid]') || event.target : event.target;
        const hint = [el.id,el.getAttribute('name'),el.getAttribute('data-testid'),name(el),el.autocomplete].filter(Boolean).join(' ').replace(/([a-z])([A-Z])/g,'$1 $2').replace(/[_-]/g,' ');
        if (el.matches('input,textarea,select') && /\\b(password|passwd|secret|token|api\\s*key|credential|card|cvv|cvc)\\b/i.test(hint)) {
            send({warning:'Credential input omitted. Use an explicit runtime secret in a manually adapted test.'}); return;
        }
        if (el.type === 'password' || el.type === 'file' || el.autocomplete?.includes('cc-') || el.autocomplete?.includes('password')) {
            send({warning:'Sensitive input omitted. Add a local fixture manually if it is required.'}); return;
        }
        if (event.type === 'click' && ['INPUT','TEXTAREA','SELECT'].includes(el.tagName) && !['checkbox','radio','submit','button'].includes(el.type)) return;
        if (event.type === 'change' && ['checkbox','radio'].includes(el.type)) return;
        if (event.type === 'keydown' && !['Enter','Escape','Tab'].includes(event.key)) return;
        const locator = locate(el);
        if (locator) locator.fingerprint = {tag:el.tagName,role:role(el),name:name(el)};
        if (!locator) { send({warning:'An action had no unique locator and was omitted.'}); return; }
        send({kind:event.type === 'click' ? 'click' : event.type === 'keydown' ? 'press' : el.tagName === 'SELECT' ? 'select' : 'fill',locator,sourceUrl:location.href,value:event.type === 'keydown' ? event.key : event.type === 'change' ? el.value : undefined});
    };
    for (const type of ['click','change','keydown']) document.addEventListener(type,handler,true);
    window.__genesisRecordingCleanup = () => {
        if (window.__genesisRecordingOwner !== owner) return false;
        for (const type of ['click','change','keydown']) document.removeEventListener(type,handler,true);
        delete window.__genesisRecordingCleanup; delete window.__genesisRecordingOwner;
        return true;
    };
    return true;
})()`;

export async function startActionRecording(options: {
    port: number;
    targetId: string;
    signal?: AbortSignal;
    maxSeconds?: number;
    onUpdate?: (snapshot: ActionRecordingSnapshot) => void;
}): Promise<ActionRecording> {
    const target = (await targets(options.port, { signal: options.signal })).find(
        (item) => item.id === options.targetId && item.type === "page"
    );
    if (!target || !/^https?:/.test(target.url)) {
        throw new Error("Choose an HTTP browser tab with a local debugging endpoint.");
    }

    const connection = new Conn(localDebuggerUrl(target, options.port), { signal: options.signal });
    const owner = crypto.randomUUID();
    const bindingName = BINDING + owner.replaceAll("-", "");
    const source = ACTION_RECORDING_SCRIPT.replaceAll("__GENESIS_RECORDING_OWNER__", owner).replaceAll(
        BINDING,
        bindingName
    );
    let claimed = false;
    let stopPromise: Promise<ActionRecordingSnapshot> | undefined;
    const state: ActionRecordingSnapshot = { initialUrl: redactBrowserText(target.url), actions: [], evidence: [] };
    let stopped = false;
    let scriptId: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => options.onUpdate?.(structuredClone(state));
    const evidence = (kind: BrowserEvidence["kind"], text: string) => {
        if (state.evidence.length < 500) {
            state.evidence.push({
                id: crypto.randomUUID(),
                kind,
                text: redactBrowserText(text),
                excluded: false,
                at: Date.now(),
            });
            update();
        }
    };
    const listener = (method: string, params: Record<string, unknown>) => {
        if (stopped || !claimed) {
            return;
        }

        if (method === "Runtime.bindingCalled" && params.name === bindingName && typeof params.payload === "string") {
            try {
                const event = SafeJSON.parse(params.payload, { strict: true }) as Record<string, unknown>;
                if (typeof event.warning === "string") {
                    evidence("warning", event.warning);
                } else if (
                    ["click", "fill", "select", "press"].includes(String(event.kind)) &&
                    validBrowserLocator(event.locator) &&
                    state.actions.length < 200
                ) {
                    state.actions.push({
                        id: crypto.randomUUID(),
                        kind: event.kind as BrowserAction["kind"],
                        locator: event.locator,
                        sourceUrl: typeof event.sourceUrl === "string" ? redactBrowserText(event.sourceUrl) : undefined,
                        value: typeof event.value === "string" ? event.value.slice(0, 4000) : undefined,
                        excluded: false,
                        at: Date.now(),
                    });
                    update();
                }
            } catch (error) {
                log.warn({ error }, "discarding malformed recorder event");
            }
        }

        if (method === "Runtime.consoleAPICalled") {
            const args = Array.isArray(params.args) ? params.args : [];
            evidence(
                "console",
                String(params.type) +
                    ": " +
                    args
                        .map((arg) =>
                            typeof arg === "object" && arg ? String(arg.value ?? arg.description ?? "") : ""
                        )
                        .join(" ")
            );
        }

        if (method === "Runtime.exceptionThrown") {
            evidence("console", SafeJSON.stringify(params.exceptionDetails));
        }

        if (method === "Network.responseReceived") {
            const response = params.response as Record<string, unknown> | undefined;
            evidence("network", `${response?.status} ${response?.url}`);
        }

        if (method === "Network.loadingFailed") {
            evidence("network", `Request failed: ${params.errorText}`);
        }

        if (method === "Page.frameNavigated") {
            const frame = params.frame as Record<string, unknown> | undefined;
            if (frame && !frame.parentId && typeof frame.url === "string") {
                evidence("navigation", frame.url);
                if (state.actions.length < 200) {
                    state.actions.push({
                        id: crypto.randomUUID(),
                        kind: "navigate",
                        url: redactBrowserText(frame.url),
                        excluded: false,
                        at: Date.now(),
                    });
                }
            }
        }
    };
    const stop = (): Promise<ActionRecordingSnapshot> => {
        if (stopPromise) {
            return stopPromise;
        }
        stopped = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        connection.off(listener);
        stopPromise = (async () => {
            const steps: { method: string; params: Record<string, unknown> }[] = [];
            if (scriptId) {
                steps.push({ method: "Page.removeScriptToEvaluateOnNewDocument", params: { identifier: scriptId } });
            }
            if (claimed) {
                steps.push({ method: "Runtime.removeBinding", params: { name: bindingName } });
                steps.push({
                    method: "Runtime.evaluate",
                    params: {
                        expression: `(() => { if (window.__genesisRecordingOwner !== ${SafeJSON.stringify(owner, { strict: true })}) return false; if (typeof window.__genesisRecordingCleanup === 'function') return window.__genesisRecordingCleanup(); delete window.__genesisRecordingOwner; return true; })()`,
                    },
                });
            }
            try {
                for (const step of steps) {
                    await connection.send(step.method, step.params, undefined, { timeoutMs: 2000 }).catch((error) => {
                        log.debug({ error, method: step.method }, "owned recorder cleanup after page closed");
                    });
                }
            } finally {
                connection.close();
            }
            return structuredClone(state);
        })();
        return stopPromise;
    };
    const abort = () => {
        void stop();
    };
    connection.on(listener);
    try {
        for (const domain of ["Runtime", "Page", "Network"]) {
            await connection.send(`${domain}.enable`, {}, undefined, { signal: options.signal });
        }
        const admission = (await connection.send(
            "Runtime.evaluate",
            {
                expression: `(() => { if (window.__genesisRecordingOwner || window.__genesisRecordingCleanup) return false; window.__genesisRecordingOwner = ${SafeJSON.stringify(owner, { strict: true })}; return window.__genesisRecordingOwner === ${SafeJSON.stringify(owner, { strict: true })}; })()`,
                returnByValue: true,
            },
            undefined,
            { signal: options.signal }
        )) as { result?: { value?: unknown } };
        if (admission.result?.value !== true) {
            throw new Error("Another recording owns this tab. Stop it first, or reload a stale recorder marker.");
        }
        claimed = true;
        await connection.send("Runtime.addBinding", { name: bindingName }, undefined, { signal: options.signal });
        const added = (await connection.send(
            "Page.addScriptToEvaluateOnNewDocument",
            {
                source,
            },
            undefined,
            { signal: options.signal }
        )) as { identifier: string };
        scriptId = added.identifier;
        const initialized = (await connection.send(
            "Runtime.evaluate",
            { expression: source, returnByValue: true },
            undefined,
            {
                signal: options.signal,
            }
        )) as { result?: { value?: unknown } };
        if (initialized.result?.value !== true) {
            throw new Error("Recorder initialization lost its tab ownership. Observe the tab before recording again.");
        }
        options.signal?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(
            () => {
                evidence("warning", "Recording reached its time limit.");
                void stop();
            },
            Math.min(600, Math.max(1, options.maxSeconds ?? 300)) * 1000
        );
        if (options.signal?.aborted) {
            await stop();
            throw options.signal.reason;
        }
        log.info({ port: options.port, targetId: options.targetId }, "action recording started");
        return { snapshot: () => structuredClone(state), stop };
    } catch (error) {
        await stop();
        throw error;
    }
}
