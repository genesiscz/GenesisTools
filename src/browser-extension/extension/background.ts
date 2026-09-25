import {
    EXTENSION_PAGE_COMMANDS,
    type HostRequest,
    type HostResponse,
    hostReplyDeadlineMs,
    NATIVE_HOST_NAME,
} from "../lib/host/messages";
import { type ContextMenuInfo, ext, type MessageSender, type Tab } from "./chrome";
import { type BackgroundMessage, isBackgroundMessage, isHostResponse, isRecord, type MenuItem } from "./shared/bridge";

const ROUTER_RULE_ID = 1;
/** Bypass rules take ids from here up, one per route page tab. */
const BYPASS_RULE_BASE = 1000;
const BYPASS_EXPIRY_MS = 30_000;
const GITLAB_SCRIPT_PREFIX = "gitlab-";

/**
 * One port per request. An open native port keeps the MV3 worker alive for as long as the host
 * works (a hunk explanation can take minutes), and the host exits when the port closes. A reply
 * that does not come by the command's deadline closes the port and fails the request.
 */
function callNative(request: HostRequest): Promise<HostResponse> {
    return new Promise((resolve) => {
        let settled = false;
        const port = ext.runtime.connectNative(NATIVE_HOST_NAME);
        const deadlineMs = hostReplyDeadlineMs(request.command);
        const settle = (response: HostResponse) => {
            if (settled) {
                return;
            }

            settled = true;
            clearTimeout(timer);
            resolve(response);
        };
        const timer = setTimeout(() => {
            settle({
                ok: false,
                code: "failed",
                error: `the native host sent no reply to ${request.command} within ${Math.round(deadlineMs / 1000)} s`,
            });
            port.disconnect();
        }, deadlineMs);

        port.onMessage.addListener((message) => {
            settle(
                isHostResponse(message)
                    ? message
                    : { ok: false, code: "failed", error: "the native host sent no reply" }
            );
            port.disconnect();
        });
        port.onDisconnect.addListener(() => {
            const reason = ext.runtime.lastError?.message ?? "the native host closed";
            settle({
                ok: false,
                code: "unavailable",
                error: `${reason}. Run: tools browser-extension install-host`,
            });
        });
        port.postMessage(request);
    });
}

function escapeRegex(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** genesis.tools links open route.html before any request leaves the browser. */
async function installRouterRule(): Promise<void> {
    await ext.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [ROUTER_RULE_ID],
        addRules: [
            {
                id: ROUTER_RULE_ID,
                priority: 1,
                action: {
                    type: "redirect",
                    redirect: { regexSubstitution: `${ext.runtime.getURL("route.html")}#\\0` },
                },
                condition: { regexFilter: "^https://genesis\\.tools/.*$", resourceTypes: ["main_frame"] },
            },
        ],
    });
}

/** The pending bypass of each route page tab: its own rule, so two tabs never remove each other's. */
const bypasses = new Map<number, { ruleId: number; expiry: ReturnType<typeof setTimeout> }>();
let nextBypassRuleId = BYPASS_RULE_BASE;

async function dropBypass(tabId: number): Promise<void> {
    const bypass = bypasses.get(tabId);

    if (!bypass) {
        return;
    }

    bypasses.delete(tabId);
    clearTimeout(bypass.expiry);
    await ext.declarativeNetRequest.updateSessionRules({ removeRuleIds: [bypass.ruleId] });
}

/** A worker that starts fresh holds no pending bypass, so a bypass rule left by the last one is stale. */
async function clearStaleBypasses(): Promise<void> {
    const rules = await ext.declarativeNetRequest.getSessionRules();
    const stale = rules.filter((rule) => rule.id >= BYPASS_RULE_BASE).map((rule) => rule.id);

    if (stale.length > 0) {
        await ext.declarativeNetRequest.updateSessionRules({ removeRuleIds: stale });
    }
}

const staleBypassesCleared = clearStaleBypasses().catch((error: unknown) => {
    console.warn("[genesis-tools] clearing stale bypass rules failed", error);
});

/**
 * Lets one URL through to the public site, for "continue anyway" on the route page. The rule
 * matches only the route page's own tab, and it goes away when that tab's next load completes,
 * when the tab closes, or after a short expiry, so a later navigation to the same URL is routed
 * again. Each tab has its own rule, so a second route page never undoes the first one's.
 */
async function allowOnce(url: string, tabId: number): Promise<void> {
    await staleBypassesCleared;
    const previous = bypasses.get(tabId);
    const ruleId = nextBypassRuleId++;
    await ext.declarativeNetRequest.updateSessionRules({
        removeRuleIds: previous ? [previous.ruleId] : [],
        addRules: [
            {
                id: ruleId,
                priority: 2,
                action: { type: "allow" },
                condition: { regexFilter: `^${escapeRegex(url)}$`, resourceTypes: ["main_frame"], tabIds: [tabId] },
            },
        ],
    });
    clearTimeout(previous?.expiry);
    bypasses.set(tabId, { ruleId, expiry: setTimeout(() => void dropBypass(tabId), BYPASS_EXPIRY_MS) });
}

ext.tabs.onUpdated.addListener((tabId, change) => {
    if (change.status === "complete") {
        void dropBypass(tabId);
    }
});

ext.tabs.onRemoved.addListener((tabId) => {
    void dropBypass(tabId);
});

/** The content script on every self-hosted GitLab the user has granted access to. */
async function syncGitlabScripts(): Promise<string[]> {
    const reply = await callNative({ command: "config.get" });
    const config = reply.ok && isRecord(reply.data) && isRecord(reply.data.config) ? reply.data.config : null;
    const hosts = Array.isArray(config?.gitlabHosts)
        ? config.gitlabHosts.filter((host): host is string => typeof host === "string")
        : [];
    const registered = await ext.scripting.getRegisteredContentScripts();
    const stale = registered.filter((script) => script.id.startsWith(GITLAB_SCRIPT_PREFIX)).map((script) => script.id);

    if (stale.length > 0) {
        await ext.scripting.unregisterContentScripts({ ids: stale });
    }

    const active: string[] = [];

    for (const host of hosts) {
        const origin = `https://${host}/*`;

        if (!(await ext.permissions.contains({ origins: [origin] }))) {
            continue;
        }

        await ext.scripting.registerContentScripts([
            {
                id: `${GITLAB_SCRIPT_PREFIX}${host}`,
                matches: [origin],
                js: ["content.js"],
                runAt: "document_idle",
                persistAcrossSessions: true,
            },
        ]);
        active.push(host);
    }

    await installMenus(active);
    return active;
}

const MENU_TITLES: Record<MenuItem, [string, string[]]> = {
    "open-file": ["Open locally in the editor", ["page", "selection", "link"]],
    "open-terminal": ["Open the checkout in a terminal", ["page"]],
    explain: ["Explain the selected hunk", ["selection"]],
    review: ["Review with agent", ["page"]],
};

async function installMenus(gitlabHosts: string[]): Promise<void> {
    await ext.contextMenus.removeAll();
    const documentUrlPatterns = ["https://github.com/*", ...gitlabHosts.map((host) => `https://${host}/*`)];

    for (const [id, [title, contexts]] of Object.entries(MENU_TITLES)) {
        ext.contextMenus.create({ id, title, contexts, documentUrlPatterns });
    }
}

function isMenuItem(value: unknown): value is MenuItem {
    return typeof value === "string" && value in MENU_TITLES;
}

ext.contextMenus.onClicked.addListener((info: ContextMenuInfo, tab?: Tab) => {
    if (tab?.id === undefined || !isMenuItem(info.menuItemId)) {
        return;
    }

    void ext.tabs.sendMessage(tab.id, { type: "menu", item: info.menuItemId, selectionText: info.selectionText });
});

async function handle(message: BackgroundMessage, sender: MessageSender): Promise<unknown> {
    switch (message.type) {
        case "host":
            return callNative({ command: message.command, params: message.params });
        case "gitlab.sync":
            return { ok: true, data: await syncGitlabScripts() };
        case "router.bypass":
            if (sender.tab?.id === undefined) {
                return { ok: false, code: "invalid", error: "a router bypass needs the route page's tab" };
            }

            await allowOnce(message.url, sender.tab.id);
            return { ok: true, data: null };
    }
}

/** Config writes, configured actions and router routes come only from the extension's own pages. */
function allowedFrom(message: BackgroundMessage, sender: MessageSender): boolean {
    const fromExtensionPage = sender.tab === undefined || (sender.url ?? "").startsWith(ext.runtime.getURL(""));

    if (message.type !== "host") {
        return fromExtensionPage;
    }

    return fromExtensionPage || !EXTENSION_PAGE_COMMANDS.includes(message.command);
}

ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Only this extension's own pages and content scripts reach here (no externally_connectable).
    if (sender.id !== ext.runtime.id || !isBackgroundMessage(message)) {
        sendResponse({ ok: false, code: "invalid", error: "unexpected message" });
        return undefined;
    }

    if (!allowedFrom(message, sender)) {
        sendResponse({
            ok: false,
            code: "invalid",
            error: "this command is only available from the extension's own pages",
        });
        return undefined;
    }

    handle(message, sender).then(sendResponse, (error: unknown) =>
        sendResponse({ ok: false, code: "failed", error: error instanceof Error ? error.message : String(error) })
    );
    return true;
});

async function setup(): Promise<void> {
    await installRouterRule();
    await syncGitlabScripts().catch(async (error: unknown) => {
        console.warn("[genesis-tools] GitLab script sync failed", error);
        await installMenus([]);
    });
}

ext.runtime.onInstalled.addListener(() => void setup());
ext.runtime.onStartup.addListener(() => void setup());
