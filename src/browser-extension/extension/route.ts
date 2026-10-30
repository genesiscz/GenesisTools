import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import type { HostResponse, PlainNavigationService, RouterEnsureData } from "../lib/host/messages";
import { allowsPlainNavigation, loopbackOrigins, loopbackPort, readPlainNavigationServices } from "../lib/loopback";
import { ext } from "./chrome";
import { callHost, isHostResponse, isRecord } from "./shared/bridge";
import { mountPage, required } from "./shared/page";
import { targetFromHash } from "./shared/route-target";

const CLOSE_AFTER_MS = 1500;
const HANDOFFS_KEY = "router.handoffs";
/** The loop ran at one tab every half second; nobody types the same link twice this fast. */
const LOOP_WINDOW_MS = 5000;
const CONTINUES_KEY = "router.continues";
/** A bypass that does not match sends the tab back here within milliseconds; a reload comes later than this. */
const CONTINUE_LOOP_WINDOW_MS = 2000;

async function recentClaims(key: string, windowMs: number): Promise<Record<string, number>> {
    const stored = (await ext.storage.session.get([key]))[key];
    const recent: Record<string, number> = {};

    if (isRecord(stored)) {
        for (const [url, at] of Object.entries(stored)) {
            if (typeof at === "number" && Date.now() - at < windowMs) {
                recent[url] = at;
            }
        }
    }

    return recent;
}

function handoffs(): Promise<Record<string, number>> {
    return recentClaims(HANDOFFS_KEY, LOOP_WINDOW_MS);
}

/**
 * A link GenesisTools.app sends back to this browser unrouted lands on this page again, which would
 * hand it over again, forever (2026-09-30: an older app copy answered `https://dashboard/`).
 */
async function cameBack(url: string): Promise<boolean> {
    return (await handoffs())[url] !== undefined;
}

async function rememberHandoff(url: string): Promise<void> {
    await ext.storage.session.set({ [HANDOFFS_KEY]: { ...(await handoffs()), [url]: Date.now() } });
}

async function forgetHandoff(url: string): Promise<void> {
    const { [url]: _dropped, ...rest } = await handoffs();
    await ext.storage.session.set({ [HANDOFFS_KEY]: rest });
}

/** One tab and one URL: another tab opening the same address is not a loop. */
function continueKey(tabId: number | undefined, url: string): string {
    return `${tabId ?? "?"} ${url}`;
}

/** This tab was just sent on to `url` and the bypass did not let it through, so it would start the server again, forever. */
async function continuedBack(tabId: number | undefined, url: string): Promise<boolean> {
    return (await recentClaims(CONTINUES_KEY, CONTINUE_LOOP_WINDOW_MS))[continueKey(tabId, url)] !== undefined;
}

async function rememberContinue(tabId: number | undefined, url: string): Promise<void> {
    const recent = await recentClaims(CONTINUES_KEY, CONTINUE_LOOP_WINDOW_MS);
    await ext.storage.session.set({ [CONTINUES_KEY]: { ...recent, [continueKey(tabId, url)]: Date.now() } });
}

/**
 * The service list, downloaded now through the worker (which re-installs its loopback rule from it). An empty list
 * when the host does not answer: nothing is started on a list that did not arrive.
 */
async function downloadServices(): Promise<PlainNavigationService[]> {
    try {
        const reply = await ext.runtime.sendMessage({ type: "router.services" });

        if (isHostResponse(reply) && reply.ok) {
            return readPlainNavigationServices(reply.data);
        }

        console.warn("[genesis-tools] the service list did not download", reply);
    } catch (error) {
        console.warn("[genesis-tools] the service list did not download", error);
    }

    return [];
}

/** The server a typed loopback address may start: its downloaded flag is true and this build holds both its origins. */
async function startableLoopback(port: number): Promise<PlainNavigationService | null> {
    const services = await downloadServices();

    if (!allowsPlainNavigation(services, port)) {
        return null;
    }

    if (!(await ext.permissions.contains({ origins: loopbackOrigins(port) }))) {
        return null;
    }

    return services.find((service) => service.port === port) ?? null;
}

async function leave(): Promise<void> {
    const tab = await ext.tabs.getCurrent();

    if (history.length > 1) {
        history.back();
    } else if (tab?.id !== undefined) {
        await ext.tabs.remove(tab.id);
    }
}

/**
 * Router link navigations land here (a declarativeNetRequest redirect puts the original URL in
 * the fragment), so nothing reaches the public server unless the user chooses to continue.
 *
 * A web page can navigate to a router link without a click, so a route that RUNS something
 * waits for a click on this page, and the page refuses to act inside a frame.
 */
async function main(): Promise<void> {
    mountPage();
    const target = targetFromHash(location.hash);
    const status = required<HTMLElement>("#status");
    const onward = required<HTMLAnchorElement>("#continue");
    const run = required<HTMLButtonElement>("#run");
    const close = required<HTMLButtonElement>("#close");
    required<HTMLElement>("#url").textContent = target;
    close.addEventListener("click", () => void leave());

    const fail = (reply: HostResponse) => {
        status.className = "gt-error";
        status.textContent = reply.ok ? "unexpected reply" : reply.error;
        close.hidden = false;
    };

    if (window.top !== window) {
        status.className = "gt-error";
        status.textContent = "Refused: router links are only routed in a top-level tab.";
        return;
    }

    const tabId = (await ext.tabs.getCurrent())?.id;

    /** Loads `url` in this tab, past the redirect rules, once. */
    const continueHere = async (url: string) => {
        const bypass = await ext.runtime.sendMessage({ type: "router.bypass", url });

        if (!isHostResponse(bypass) || !bypass.ok) {
            // Navigating anyway would only land on this page again.
            fail(isHostResponse(bypass) ? bypass : { ok: false, code: "failed", error: "the bypass was refused" });
            return;
        }

        await rememberContinue(tabId, url);
        location.replace(url);
    };

    /**
     * Starts the server here and stays in this tab: never `router.route`, which hands the link to GenesisTools.app,
     * and that opens a second tab. A server that does not come up shows the error with its log, and the dead page
     * is not opened.
     */
    const startHere = async (name: string): Promise<HostResponse<RouterEnsureData>> => {
        status.className = "gt-muted";
        status.textContent = `Opening ${name}, starting it if it is not running...`;
        const ensured = await callHost<RouterEnsureData>("router.ensure", { url: target });

        if (!ensured.ok) {
            return ensured;
        }

        // Only ever on to the started server's own loopback address.
        if (loopbackPort(ensured.data.target) !== ensured.data.port) {
            return {
                ok: false,
                code: "failed",
                error: `the router sent this to ${ensured.data.target}, not to its server`,
            };
        }

        status.textContent = ensured.data.started ? `Started ${ensured.data.name}` : `${ensured.data.name} is up`;
        await continueHere(ensured.data.target);
        return ensured;
    };

    if (await continuedBack(tabId, target)) {
        status.className = "gt-error";
        status.textContent = `This tab was just sent to this address and came back here, so it is not started again. Run ${toolCommand("browser-router status")}.`;
        close.hidden = false;
        return;
    }

    const port = loopbackPort(target);

    if (port !== null) {
        const service = await startableLoopback(port);

        // Not a server this extension may start: it loads as typed, as it would without the extension.
        if (!service) {
            await continueHere(target);
            return;
        }

        const ensured = await startHere(service.name);

        // `invalid` is the host's own refusal (a saved route that runs something matched first): the router decides below.
        if (ensured.ok || ensured.code !== "invalid") {
            if (!ensured.ok) {
                fail(ensured);
            }

            return;
        }
    }

    const explained = await callHost("router.explain", { url: target });

    if (!explained.ok || !isRecord(explained.data)) {
        fail(explained);
        return;
    }

    const decision = explained.data;

    if (await cameBack(target)) {
        status.className = "gt-error";
        status.textContent = `GenesisTools.app sent this link straight back to the browser, so it is not handed over again. Run ${toolCommand("browser-router status")} and ${toolCommand("browser-router explain")} on it.`;
        close.hidden = false;
        return;
    }

    // A dashboard name whose live flag allows it: the same plain-browser-navigation decision as its loopback address.
    if (decision.plainNavigation === true && isRecord(decision.service) && typeof decision.service.name === "string") {
        const ensured = await startHere(decision.service.name);

        if (!ensured.ok) {
            fail(ensured);
        }

        return;
    }

    // A loopback address is never handed to GenesisTools.app (it would open it in a second tab, which lands here
    // again): unless a saved route runs something, it loads as typed.
    if (port !== null && decision.runs !== true) {
        await continueHere(target);
        return;
    }

    if (decision.handled !== true) {
        status.className = "gt-muted";
        status.textContent = "No local route matches this link, so the router would only send it back to this browser.";
        onward.hidden = false;
        close.hidden = false;
        onward.addEventListener("click", async (event) => {
            event.preventDefault();
            const bypass = await ext.runtime.sendMessage({ type: "router.bypass", url: target });

            if (!isHostResponse(bypass) || !bypass.ok) {
                // Navigating anyway would only land on this page again.
                fail(isHostResponse(bypass) ? bypass : { ok: false, code: "failed", error: "the bypass was refused" });
                return;
            }

            location.href = target;
        });
        return;
    }

    const hand = async () => {
        run.disabled = true;
        // Claimed BEFORE the host runs: the app can send the URL straight back while this page still
        // waits for the host's answer, and that second page must find the claim.
        await rememberHandoff(target);
        const routed = await callHost("router.route", { url: target });

        if (!routed.ok) {
            await forgetHandoff(target);
            fail(routed);
            // A host or router failure can pass: Run stays usable for another try.
            run.disabled = false;
            return;
        }

        status.className = "gt-ok";
        status.textContent = `Handed to GenesisTools: ${String(decision.summary ?? decision.kind ?? "")}`;
        setTimeout(() => void leave(), CLOSE_AFTER_MS);
    };

    if (decision.runs === true) {
        status.className = "gt-muted";
        status.textContent = `This link runs: ${String(decision.summary ?? "")}`;
        run.hidden = false;
        run.addEventListener("click", () => void hand());
        return;
    }

    await hand();
}

void main();
