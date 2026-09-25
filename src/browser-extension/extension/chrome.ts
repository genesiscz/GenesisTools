/**
 * The slice of the extension APIs this extension calls, typed here. It is a module-local
 * declaration on purpose: the YouTube extension declares a global `chrome` namespace for its own
 * slice, and a second global declaration would collide with it in the shared typecheck.
 */
export interface NativePort {
    postMessage(message: unknown): void;
    disconnect(): void;
    onMessage: { addListener(listener: (message: unknown) => void): void };
    onDisconnect: { addListener(listener: () => void): void };
}

export interface Tab {
    id?: number;
    url?: string;
}

export interface MessageSender {
    tab?: Tab;
    id?: string;
    /** The sending document: an extension page, or the web page a content script runs in. */
    url?: string;
}

export interface ContextMenuInfo {
    menuItemId: string | number;
    selectionText?: string;
    linkUrl?: string;
    pageUrl?: string;
}

export interface DnrRule {
    id: number;
    priority: number;
    action: { type: "redirect"; redirect: { regexSubstitution: string } } | { type: "allow" };
    /** `tabIds` is honoured on session rules only. */
    condition: { regexFilter: string; resourceTypes: "main_frame"[]; tabIds?: number[] };
}

export interface RegisteredContentScript {
    id: string;
    matches: string[];
    js: string[];
    runAt?: "document_idle";
    persistAcrossSessions?: boolean;
}

export interface ChromeApi {
    runtime: {
        id: string;
        lastError?: { message?: string };
        getURL(path: string): string;
        sendMessage(message: unknown): Promise<unknown>;
        connectNative(name: string): NativePort;
        openOptionsPage(): Promise<void>;
        onMessage: {
            addListener(
                listener: (
                    message: unknown,
                    sender: MessageSender,
                    sendResponse: (response: unknown) => void
                ) => boolean | undefined
            ): void;
        };
        onInstalled: { addListener(listener: () => void): void };
        onStartup: { addListener(listener: () => void): void };
    };
    tabs: {
        query(info: { active?: boolean; currentWindow?: boolean }): Promise<Tab[]>;
        sendMessage(tabId: number, message: unknown): Promise<unknown>;
        getCurrent(): Promise<Tab | undefined>;
        remove(tabId: number): Promise<void>;
        update(tabId: number, properties: { url: string }): Promise<Tab>;
        onUpdated: { addListener(listener: (tabId: number, change: { status?: string }) => void): void };
        onRemoved: { addListener(listener: (tabId: number) => void): void };
    };
    contextMenus: {
        create(properties: { id: string; title: string; contexts: string[]; documentUrlPatterns?: string[] }): void;
        removeAll(): Promise<void>;
        onClicked: { addListener(listener: (info: ContextMenuInfo, tab?: Tab) => void): void };
    };
    scripting: {
        executeScript<Args extends unknown[], Result>(injection: {
            target: { tabId: number };
            func: (...args: Args) => Result;
            args: Args;
        }): Promise<{ result?: Result }[]>;
        registerContentScripts(scripts: RegisteredContentScript[]): Promise<void>;
        unregisterContentScripts(filter?: { ids: string[] }): Promise<void>;
        getRegisteredContentScripts(): Promise<RegisteredContentScript[]>;
    };
    permissions: {
        contains(permissions: { origins: string[] }): Promise<boolean>;
        request(permissions: { origins: string[] }): Promise<boolean>;
    };
    declarativeNetRequest: {
        updateDynamicRules(options: { removeRuleIds?: number[]; addRules?: DnrRule[] }): Promise<void>;
        updateSessionRules(options: { removeRuleIds?: number[]; addRules?: DnrRule[] }): Promise<void>;
        getSessionRules(): Promise<DnrRule[]>;
    };
}

declare const chrome: ChromeApi;

export const ext: ChromeApi = chrome;
