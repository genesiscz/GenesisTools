import type { HostResponse } from "../lib/host/messages";
import { ext } from "./chrome";
import { callHost, isHostResponse, isRecord } from "./shared/bridge";
import { mountPage, required } from "./shared/page";
import { targetFromHash } from "./shared/route-target";

const CLOSE_AFTER_MS = 1500;
const HANDOFFS_KEY = "router.handoffs";
/** The loop ran at one tab every half second; nobody types the same link twice this fast. */
const LOOP_WINDOW_MS = 5000;

async function handoffs(): Promise<Record<string, number>> {
    const stored = (await ext.storage.session.get([HANDOFFS_KEY]))[HANDOFFS_KEY];
    const recent: Record<string, number> = {};

    if (isRecord(stored)) {
        for (const [url, at] of Object.entries(stored)) {
            if (typeof at === "number" && Date.now() - at < LOOP_WINDOW_MS) {
                recent[url] = at;
            }
        }
    }

    return recent;
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

    const explained = await callHost("router.explain", { url: target });

    if (!explained.ok || !isRecord(explained.data)) {
        fail(explained);
        return;
    }

    const decision = explained.data;

    if (await cameBack(target)) {
        status.className = "gt-error";
        status.textContent =
            "GenesisTools.app sent this link straight back to the browser, so it is not handed over again. Run tools browser-router status and tools browser-router explain on it.";
        close.hidden = false;
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
