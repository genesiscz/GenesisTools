import {
    EXTENSION_PAGE_COMMANDS,
    type HostRequest,
    type HostResponse,
    hostReplyDeadlineMs,
    NATIVE_HOST_NAME,
} from "../lib/host/messages";
import { type ContextMenuInfo, type DnrRule, ext, type MessageSender, type Tab } from "./chrome";
import { type BackgroundMessage, isBackgroundMessage, isHostResponse, isRecord, type MenuItem } from "./shared/bridge";
import { freshnessFromReply, showFreshness } from "./shared/freshness";

const ROUTER_RULE_ID = 1;
const SHORTCUT_RULE_ID = 2;
/** Search rules take ids from here up, one per short host, below the bypass range. */
const SEARCH_RULE_BASE = 100;
/**
 * The engines a bare word typed in the address bar goes to. The manifest grants each one: a
 * redirect only fires on a host the extension may access.
 */
const SEARCH_ENGINES = ["google.com", "google.cz", "search.brave.com", "duckduckgo.com", "bing.com"];
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

/** Each letter as `[xX]`; safe on `escapeRegex` output, which escapes punctuation only. */
function caseInsensitive(pattern: string): string {
    return pattern.replace(/[a-z]/gi, (letter) => `[${letter.toLowerCase()}${letter.toUpperCase()}]`);
}

interface RouterHosts {
    linkHost: string | null;
    hosts: string[];
}

/** The build's `router-hosts.json`: the link host, and the hosts the router config wants caught. */
async function routerHosts(): Promise<RouterHosts> {
    try {
        const response = await fetch(ext.runtime.getURL("router-hosts.json"));
        const data: unknown = await response.json();

        if (isRecord(data)) {
            const linkHost = typeof data.linkHost === "string" ? data.linkHost : null;
            const hosts = Array.isArray(data.hosts)
                ? data.hosts.filter((host): host is string => typeof host === "string")
                : [];
            return { linkHost, hosts };
        }
    } catch (error) {
        console.warn("[genesis-tools] router-hosts.json is missing or unreadable", error);
    }

    return { linkHost: null, hosts: [] };
}

function routeRedirect(): DnrRule["action"] {
    return { type: "redirect", redirect: { regexSubstitution: `${ext.runtime.getURL("route.html")}#\\0` } };
}

/** Link-host links and the router's other hosts open route.html before any request leaves the browser. */
async function installRouterRule(): Promise<void> {
    const { linkHost, hosts } = await routerHosts();
    await ext.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [ROUTER_RULE_ID],
        addRules: linkHost
            ? [
                  {
                      id: ROUTER_RULE_ID,
                      priority: 1,
                      action: routeRedirect(),
                      condition: {
                          // The router's link pattern takes both protocols, so the rule does too.
                          regexFilter: `^https?://${escapeRegex(linkHost)}/.*$`,
                          resourceTypes: ["main_frame"],
                      },
                  },
              ]
            : [],
    });
    await installHostRule(hosts).catch((error: unknown) => {
        console.warn("[genesis-tools] router host rule failed", error);
    });
    await installSearchRules(hosts.filter((host) => !host.includes("."))).catch((error: unknown) => {
        console.warn("[genesis-tools] short host search rules failed", error);
    });
}

/**
 * A bare `dashboard` typed in the address bar is a search, not a URL, so it never reaches the host
 * rule. A search whose whole query is one short host goes to the route page as that host instead.
 *
 * The engines go in `requestDomains` and the regex holds only the query: with the engine paths in
 * it too, `artifact-library` and `dev-dashboard-cloud` passed Chrome's regex memory limit. Each
 * rule has its own call, since one refused rule fails every other rule in the same call.
 */
async function installSearchRules(hosts: string[]): Promise<void> {
    const stale = (await ext.declarativeNetRequest.getDynamicRules())
        .map((rule) => rule.id)
        .filter((id) => id >= SEARCH_RULE_BASE && id < BYPASS_RULE_BASE);
    await ext.declarativeNetRequest.updateDynamicRules({ removeRuleIds: stale });

    for (const [index, host] of hosts.entries()) {
        const rule: DnrRule = {
            id: SEARCH_RULE_BASE + index,
            priority: 1,
            action: { type: "redirect", redirect: { extensionPath: `/route.html#http://${host}/` } },
            condition: {
                // regexFilter ignores isUrlFilterCaseSensitive, so `q=Dashboard` needs a class per letter.
                regexFilter: `[?&]q=${caseInsensitive(escapeRegex(host))}(?:&|#|$)`,
                requestDomains: SEARCH_ENGINES,
                resourceTypes: ["main_frame"],
            },
        };
        await ext.declarativeNetRequest.updateDynamicRules({ addRules: [rule] }).catch((error: unknown) => {
            console.warn(`[genesis-tools] search rule for ${host} failed`, error);
        });
    }
}

/**
 * Its own rule, so a failure here never costs the link-host one. The host list goes in
 * `requestDomains`, not the regex: an alternation of every host passes Chrome's 2 KB compiled
 * regex limit (seen at 14 hosts), while this regex stays the same size for any number of them.
 */
async function installHostRule(hosts: string[]): Promise<void> {
    await ext.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [SHORTCUT_RULE_ID],
        addRules:
            hosts.length === 0
                ? []
                : [
                      {
                          id: SHORTCUT_RULE_ID,
                          priority: 1,
                          action: routeRedirect(),
                          condition: {
                              regexFilter: "^https?://[^/:]+/.*$",
                              requestDomains: hosts,
                              resourceTypes: ["main_frame"],
                          },
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

type MenuContext = `${chrome.contextMenus.ContextType}`;

const MENU_TITLES: Record<MenuItem, [string, [MenuContext, ...MenuContext[]]]> = {
    "open-hub": ["Open in GenesisTools", ["page", "selection", "link"]],
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

    void ext.tabs.sendMessage(tab.id, {
        type: "menu",
        item: info.menuItemId,
        selectionText: info.selectionText,
        linkUrl: info.linkUrl,
        source: "menu",
    });
});

/** The keyboard shortcut (manifest `commands`) runs the same handler as the menu entry, on the active tab. */
ext.commands.onCommand.addListener((command, tab) => {
    if (command !== "open-in-genesistools" || tab?.id === undefined) {
        return;
    }

    // A tab without the content script (not a GitHub or granted GitLab page) has no receiver.
    ext.tabs.sendMessage(tab.id, { type: "menu", item: "open-hub", source: "shortcut" }).catch((error: unknown) => {
        console.info("[genesis-tools] the shortcut has nothing to open on this tab", error);
    });
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

/** On every browser start and install: a `!` badge when this build is behind `dist` or the sources. */
async function checkFreshness(): Promise<void> {
    await showFreshness(freshnessFromReply(await callNative({ command: "extension.status" })));
}

async function setup(): Promise<void> {
    void checkFreshness().catch((error: unknown) => {
        console.warn("[genesis-tools] freshness check failed", error);
    });
    await installRouterRule();
    await syncGitlabScripts().catch(async (error: unknown) => {
        console.warn("[genesis-tools] GitLab script sync failed", error);
        await installMenus([]);
    });
}

ext.runtime.onInstalled.addListener(() => void setup());
ext.runtime.onStartup.addListener(() => void setup());
