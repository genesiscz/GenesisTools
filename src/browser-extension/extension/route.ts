import type { HostResponse } from "../lib/host/messages";
import { ext } from "./chrome";
import { callHost, isHostResponse, isRecord } from "./shared/bridge";
import { mountPage, required } from "./shared/page";
import { targetFromHash } from "./shared/route-target";

const CLOSE_AFTER_MS = 1500;

async function leave(): Promise<void> {
    const tab = await ext.tabs.getCurrent();

    if (history.length > 1) {
        history.back();
    } else if (tab?.id !== undefined) {
        await ext.tabs.remove(tab.id);
    }
}

/**
 * genesis.tools navigations land here (a declarativeNetRequest redirect puts the original URL in
 * the fragment), so nothing reaches the public server unless the user chooses to continue.
 *
 * A web page can navigate to a genesis.tools link without a click, so a route that RUNS something
 * waits for a click on this page, and the page refuses to act inside a frame.
 */
async function main(): Promise<void> {
    mountPage();
    const target = targetFromHash(location.hash);
    const status = required<HTMLElement>("#status");
    const onward = required<HTMLAnchorElement>("#continue");
    const run = required<HTMLButtonElement>("#run");
    required<HTMLElement>("#url").textContent = target;

    const fail = (reply: HostResponse) => {
        status.className = "gt-error";
        status.textContent = reply.ok ? "unexpected reply" : reply.error;
    };

    if (window.top !== window) {
        status.className = "gt-error";
        status.textContent = "Refused: genesis.tools links are only routed in a top-level tab.";
        return;
    }

    const explained = await callHost("router.explain", { url: target });

    if (!explained.ok || !isRecord(explained.data)) {
        fail(explained);
        return;
    }

    const decision = explained.data;

    if (decision.handled !== true) {
        status.className = "gt-muted";
        status.textContent = "No local route matches this link, so the router would only send it back to this browser.";
        onward.hidden = false;
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
        const routed = await callHost("router.route", { url: target });

        if (!routed.ok) {
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
