#!/usr/bin/env bun
/**
 * Live guard check for the DOM browser backend, with no model and no network beyond loopback.
 * Ported from browser-use/jev-ultrafast `scripts/check_guards.py`.
 *
 * Runs a HEADLESS Chrome on a throwaway profile against a fixture page served on 127.0.0.1, so it
 * never touches the user's browser or screen. Each check prints PASS or FAIL; any FAIL exits 1.
 *
 *   bun src/chrome-devtools/scripts/dom-guards.ts
 *   CHROME=/path/to/chrome bun src/chrome-devtools/scripts/dom-guards.ts
 */
import { SafeJSON } from "@genesiscz/utils/json";
import { attach, newTab } from "../lib/cdp";
import type { DomAction, DomSnapshot } from "../lib/dom/in-page";
import { DomPage } from "../lib/dom/page";
import { launchHeadlessChrome } from "../lib/headless";
import { createTabDriver, TabGoneError } from "../lib/tab-driver";
import { closeTab, currentTab, listTabs } from "../lib/tabs";

const GUARDS_HTML = `<!doctype html><html><head><title>Guards</title><style>
body{font:14px sans-serif;margin:0;padding:10px}
#cover{position:fixed;inset:0;display:none;z-index:10}
</style></head><body>
<output id="log">ready</output>
<p id="ticker">tick 0</p>
<button id="move" onclick="log('moved clicked')">Move me</button>
<button id="noop">Nothing happens</button>
<button id="covered" onclick="log('covered clicked')">Covered</button>
<button id="hover-cover">Hover cover</button>
<button id="hover-move">Hover move</button>
<button id="stable-hover">Stable hover</button>
<button id="add-shadow">Add shadow</button>
<button id="hidden" style="display:none">Hidden</button>
<form onsubmit="return false">
<label for="email">Email</label><input id="email" name="email" oninput="log('email '+this.value.length)">
<label for="pw">Password</label><input id="pw" name="pw" type="password" value="preset-secret">
<select name="ship" aria-label="Shipping" onchange="log('ship '+this.value)"><option>Standard</option><option>Express</option></select>
<input type="checkbox" id="terms"><label for="terms">Terms</label>
<label for="trap">Trap</label><input id="trap" onfocus="document.getElementById('email').focus()">
</form>
<ul><li id="row">Coldplay Oct 2 <button onclick="log('buy clicked')">Buy</button></li></ul>
<select aria-label="Size" id="size"><option>Small</option><option>Large</option></select>
<a id="next" href="/b">Next page</a>
<form action="/b" id="nav-form"><input type="hidden" name="from" value="form"><button>Submit form</button></form>
<div id="cover"></div>
<script>function log(t){document.getElementById('log').textContent=t}</script>
<script>
window.downs = { target: 0, overlay: 0, stable: 0 };
document.getElementById('hover-cover').addEventListener('mouseover', event => {
  const rect = event.target.getBoundingClientRect();
  const cover = document.getElementById('cover');
  Object.assign(cover.style, {display:'block', inset:'auto', left:rect.left+'px', top:rect.top+'px', width:rect.width+'px', height:rect.height+'px'});
});
document.getElementById('hover-cover').addEventListener('mousedown', () => window.downs.target++);
document.getElementById('cover').addEventListener('mousedown', () => window.downs.overlay++);
document.getElementById('hover-move').addEventListener('mouseover', event => { event.target.style.transform = 'translateY(40px)'; });
document.getElementById('hover-move').addEventListener('mousedown', () => window.downs.target++);
document.getElementById('stable-hover').addEventListener('mousedown', () => window.downs.stable++);
document.getElementById('add-shadow').addEventListener('click', () => {
  const host = document.createElement('div');
  host.id = 'late-shadow';
  document.body.append(host);
  queueMicrotask(() => {
    const root = host.attachShadow({mode:'open'});
    root.innerHTML = '<p>early</p>';
    setTimeout(() => { root.querySelector('p').textContent = 'late shadow ready'; }, 20);
  });
});
</script>
</body></html>`;
const SECOND_HTML = "<!doctype html><title>B</title><p>Second page</p>";
// An extension-style panel in an open shadow root, a nested component, and a closed root that
// must stay invisible.
const SHADOW_HTML = `<!doctype html><html><head><title>Shadow</title></head><body>
<output id="log">ready</output>
<div id="host"></div><div id="closed-host"></div>
<div style="height:3000px"></div><label>Deep password <input type="password"></label>
<script>
class DeepPart extends HTMLElement {
  constructor() {
    super();
    const inner = this.attachShadow({ mode: "open" });
    inner.innerHTML = "<button>Deep action</button>";
    inner.querySelector("button").addEventListener("click", () => { document.getElementById("log").textContent = "deep clicked"; });
  }
}
customElements.define("deep-part", DeepPart);
const panel = document.getElementById("host").attachShadow({ mode: "open" });
panel.innerHTML = '<p>Panel text</p><span id="q-label">Question</span><input aria-labelledby="q-label"><button id="sum">Summarize</button><p id="out"></p><deep-part></deep-part>';
panel.getElementById("sum").addEventListener("click", () => { panel.getElementById("out").textContent = "Summary ready"; });
document.getElementById("closed-host").attachShadow({ mode: "closed" }).innerHTML = "<button>Closed button</button>";
</script></body></html>`;
// Sends one request with the two headers a signed-in app attaches, the way spotify's player does.
const API_HTML = `<!doctype html><title>Api</title><p>Api page</p><script>
window.pageGlobal = 42;
fetch("/api/query", { method: "POST", headers: { Authorization: "Bearer fixture-token", "client-token": "fixture-client" }, body: "{}" });
</script>`;
const BIG_HTML = `<!doctype html><title>Big</title>${Array.from(
    { length: 2000 },
    (_, index) => `<p><a href="#a${index}">Link ${index}</a> some text ${index}</p>`
).join("")}`;

let failures = 0;

function check(name: string, ok: boolean, detail = ""): void {
    if (!ok) {
        failures += 1;
    }

    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

function find(snapshot: DomSnapshot, label: string, kind?: DomAction["kind"]): DomAction {
    const action = snapshot.actions.find((item) => item.label === label && (kind === undefined || item.kind === kind));
    if (!action) {
        throw new Error(`no ${kind ?? "action"} labelled "${label}" in the snapshot`);
    }

    return action;
}

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/api/query") {
            return new Response("{}", { headers: { "content-type": "application/json" } });
        }

        const pages: Record<string, string> = {
            "/b": SECOND_HTML,
            "/big": BIG_HTML,
            "/shadow": SHADOW_HTML,
            "/api-page": API_HTML,
        };
        return new Response(pages[path] ?? GUARDS_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    },
});
const base = `http://127.0.0.1:${server.port}`;
const chrome = await launchHeadlessChrome({ binary: process.env.CHROME });

try {
    const port = chrome.port;
    const page = await DomPage.attach({ port, target: await newTab(port, `${base}/guards`) });
    const main = await attach({ port, url: "/guards" });
    const text = async () => (await page.snapshot()).text;

    const first = await page.snapshot();
    const labels = first.actions.map((action) => `${action.kind}:${action.label}`);
    check(
        "the snapshot names buttons, fields, options and links",
        [
            "click:Move me",
            "fill:Email",
            "fill:Password",
            "select:Shipping",
            "click:Terms",
            "click:Buy",
            "click:Next page",
        ].every((label) => labels.includes(label)),
        labels.join(", ")
    );
    check("a display:none control is not offered", !labels.includes("click:Hidden"));
    check("the password field's value never leaves the page", !SafeJSON.stringify(first).includes("preset-secret"));
    check(
        "the password field is marked secret",
        first.actions.some((action) => action.label === "Password" && action.field?.secret === true)
    );

    await main.evaluate("() => { document.getElementById('move').style.transform = 'translateX(40px)'; }");
    const moved = await page.click(find(first, "Move me"));
    check("a moved target is clicked at its new place", moved.ok && (await text()).includes("moved clicked"));

    const beforeTicker = await page.snapshot();
    await main.evaluate("() => { document.getElementById('ticker').textContent = 'tick 1'; }");
    const buy = await page.click(find(beforeTicker, "Buy"));
    check("a change outside the target's row does not invalidate it", buy.ok, buy.ok ? "" : buy.error);

    const beforeRow = await page.snapshot();
    await main.evaluate("() => { document.getElementById('row').firstChild.textContent = 'Adele Nov 9 '; }");
    const stale = await page.click(find(beforeRow, "Buy"));
    check(
        "a change inside the target's row makes the old choice stale",
        !stale.ok && stale.error.includes("changed"),
        stale.ok ? "clicked" : stale.error
    );

    const beforeCover = await page.snapshot();
    await main.evaluate(
        "() => { const c = document.getElementById('cover'); const r = document.getElementById('covered').getBoundingClientRect(); Object.assign(c.style, {display: 'block', inset: 'auto', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px'}); }"
    );
    const covered = await page.click(find(beforeCover, "Covered"));
    check(
        "a textless overlay over the target blocks the click",
        !covered.ok && covered.error.includes("occluded"),
        covered.ok ? "clicked" : covered.error
    );
    await main.evaluate("() => { document.getElementById('cover').style.display = 'none'; }");

    const hoverCovered = await page.click(find(await page.snapshot(), "Hover cover"));
    check(
        "an overlay created by this click's hover receives no mouse-down",
        !hoverCovered.ok &&
            !hoverCovered.dispatched &&
            (await main.evaluate("() => window.downs.target + window.downs.overlay")) === 0,
        hoverCovered.ok ? "clicked" : hoverCovered.error
    );
    await main.evaluate("() => { document.getElementById('cover').style.display = 'none'; }");
    const hoverMoved = await page.click(find(await page.snapshot(), "Hover move"));
    check(
        "a center moved by this click's hover is refused before mouse-down",
        !hoverMoved.ok && !hoverMoved.dispatched && (await main.evaluate("() => window.downs.target")) === 0,
        hoverMoved.ok ? "clicked" : hoverMoved.error
    );
    const stableHover = await page.click(find(await page.snapshot(), "Stable hover"));
    check(
        "a stable hover target receives exactly one mouse-down",
        stableHover.ok && (await main.evaluate("() => window.downs.stable")) === 1
    );
    const lateShadow = await page.click(find(await page.snapshot(), "Add shadow"));
    check(
        "settle observes a late attached shadow root and its delayed mutation",
        lateShadow.ok &&
            lateShadow.settled !== "navigated" &&
            lateShadow.settled.reason === "quiet" &&
            lateShadow.settled.mutations >= 2 &&
            (await page.snapshot()).text.includes("late shadow ready"),
        lateShadow.ok ? SafeJSON.stringify(lateShadow.settled) : lateShadow.error
    );

    const beforeFill = await page.snapshot();
    const filled = await page.fill(find(beforeFill, "Email", "fill"), "ada@example.com");
    const afterFill = await page.snapshot();
    check(
        "a fill replaces the field and is read back",
        filled.ok &&
            find(afterFill, "Email", "fill").value === "ada@example.com" &&
            afterFill.text.includes("email 15"),
        filled.ok ? "" : filled.error
    );
    const refilled = await page.fill(find(afterFill, "Email", "fill"), "bo@example.com");
    check(
        "a second fill replaces instead of appending",
        refilled.ok && find(await page.snapshot(), "Email", "fill").value === "bo@example.com"
    );

    const trapped = await page.fill(find(await page.snapshot(), "Trap", "fill"), "not-for-email");
    check(
        "a field whose focus handler moves focus elsewhere is refused before typing",
        !trapped.ok &&
            trapped.error.includes("focus moved") &&
            find(await page.snapshot(), "Email", "fill").value === "bo@example.com",
        trapped.ok ? "typed" : trapped.error
    );

    const beforeSelect = await page.snapshot();
    const express = beforeSelect.actions.find(
        (action) => action.kind === "select" && action.option?.label === "Express"
    );
    const selected = express
        ? await page.select(express)
        : { ok: false as const, error: "no option", dispatched: false };
    check("a select picks the option and fires change", selected.ok && (await text()).includes("ship Express"));

    const beforeDisable = await page.snapshot();
    const large = beforeDisable.actions.find((action) => action.kind === "select" && action.option?.label === "Large");
    // Disabling an option changes nothing the select's guard hashes, so only the option check sees it.
    await main.evaluate("() => { document.getElementById('size').options[1].disabled = true; }");
    const refused = large ? await page.select(large) : { ok: false as const, error: "no option", dispatched: false };
    check(
        "an option disabled after the read is refused, not selected",
        !refused.ok && refused.error.includes("option moved or was disabled"),
        refused.ok ? "selected" : refused.error
    );
    check(
        "the refused select left the list alone",
        (await main.evaluate("() => document.getElementById('size').value")) === "Small"
    );

    const noopStarted = performance.now();
    const noop = await page.click(find(await page.snapshot(), "Nothing happens"));
    const noopMs = performance.now() - noopStarted;
    check("a click that changes nothing settles at the cap", noop.ok && noopMs < 900, `${Math.round(noopMs)} ms`);

    const nav = await page.click(find(await page.snapshot(), "Next page"));
    const second = await page.snapshot();
    check(
        "a navigating click settles on the new document",
        nav.ok && second.url.endsWith("/b") && second.text.includes("Second page"),
        nav.ok ? SafeJSON.stringify(nav.settled) : nav.error
    );
    await page.back();
    const submitStarted = performance.now();
    const submitted = await page.click(find(await page.snapshot(), "Submit form"));
    const submitMs = performance.now() - submitStarted;
    const afterSubmit = await page.snapshot();
    check(
        "a form submit settles on the new document within 3 s",
        submitted.ok && afterSubmit.url.includes("/b?from=form") && submitMs < 3000,
        `${Math.round(submitMs)} ms, ${submitted.ok ? SafeJSON.stringify(submitted.settled) : submitted.error}`
    );

    const backStarted = performance.now();
    const back = await page.back();
    const backMs = performance.now() - backStarted;
    check(
        "back returns to the fixture without waiting out the navigation cap",
        back.ok && (await page.snapshot()).url.endsWith("/guards") && backMs < 3000,
        `${Math.round(backMs)} ms`
    );

    const shadow = await DomPage.attach({ port, target: await newTab(port, `${base}/shadow`) });
    const inShadow = await shadow.snapshot();
    const shadowLabels = inShadow.actions.map((action) => `${action.kind}:${action.label}`);
    check(
        "controls in open shadow roots are offered, nested ones too",
        ["click:Summarize", "click:Deep action", "fill:Question"].every((label) => shadowLabels.includes(label)),
        shadowLabels.join(", ")
    );
    check("a control in a closed shadow root is not offered", !shadowLabels.includes("click:Closed button"));
    check(
        "a password field far below the fold is still reported as a secret field",
        inShadow.secretFields.some((secret) => secret.label === "Deep password") &&
            !shadowLabels.includes("fill:Deep password"),
        inShadow.secretFields.map((secret) => secret.label).join(", ")
    );
    check("text in an open shadow root is read", inShadow.text.includes("Panel text"), inShadow.text.slice(0, 80));
    const summarized = await shadow.click(find(inShadow, "Summarize"));
    check(
        "a click inside a shadow root passes the hit test and its change settles as quiet",
        summarized.ok &&
            summarized.settled !== "navigated" &&
            summarized.settled.reason === "quiet" &&
            (await shadow.snapshot()).text.includes("Summary ready"),
        summarized.ok ? SafeJSON.stringify(summarized.settled) : summarized.error
    );
    const deep = await shadow.click(find(await shadow.snapshot(), "Deep action"));
    check(
        "a click two shadow roots deep reaches its button",
        deep.ok && (await shadow.snapshot()).text.includes("deep clicked"),
        deep.ok ? "" : deep.error
    );
    const asked = await shadow.fill(find(await shadow.snapshot(), "Question", "fill"), "what is new");
    check(
        "a field named by aria-labelledby inside a shadow root fills and reads back",
        asked.ok && find(await shadow.snapshot(), "Question", "fill").value === "what is new",
        asked.ok ? "" : asked.error
    );
    shadow.close();

    const big = await DomPage.attach({ port, target: await newTab(port, `${base}/big`) });
    const reads: number[] = [];
    let bigSnapshot: DomSnapshot | undefined;
    for (let index = 0; index < 10; index++) {
        const started = performance.now();
        bigSnapshot = await big.snapshot();
        reads.push(performance.now() - started);
    }
    console.log(
        `INFO  2000-link page: ${bigSnapshot?.actions.length ?? 0} actions in view, ${bigSnapshot?.belowFold ?? 0} below the fold, snapshot median ${median(reads).toFixed(1)} ms, max ${Math.max(...reads).toFixed(1)} ms over 10 reads`
    );
    check("a 2000-link page reads in one call under 250 ms", median(reads) < 250, `${median(reads).toFixed(1)} ms`);
    check(
        "controls below the fold are named for the model, capped",
        bigSnapshot?.belowFoldLabels.length === 30 && bigSnapshot.belowFoldLabels[0].startsWith("Link "),
        bigSnapshot?.belowFoldLabels.slice(0, 2).join(", ")
    );
    big.close();

    const tabs = await listTabs(port);
    check(
        "the tab list holds both fixture pages",
        tabs.some((tab) => tab.url.endsWith("/guards")) && tabs.some((tab) => tab.url.endsWith("/big"))
    );
    const byTitle = await currentTab({ port, title: "Guards" });
    check("the current tab is found by its window title", byTitle.url.endsWith("/guards"), byTitle.url);
    const bigTab = tabs.find((tab) => tab.url.endsWith("/big"));
    if (bigTab) {
        await closeTab(port, bigTab.id);
    }

    check("a tab closes over CDP", !(await listTabs(port)).some((tab) => tab.url.endsWith("/big")));

    const driver = createTabDriver(port);
    const apiTab = await driver.open(`${base}/api-page`);
    check("the tab driver opens a tab and waits for its load", apiTab.url.endsWith("/api-page"), apiTab.url);
    check(
        "the tab driver evaluates in the page's own world",
        (await driver.evaluate(apiTab.id, "() => window.pageGlobal")) === 42
    );
    check(
        "an async function's value is awaited",
        (await driver.evaluate(apiTab.id, "async () => { await 0; return document.title; }")) === "Api"
    );
    const thrown = await driver
        .evaluate(apiTab.id, "() => { throw new Error('fixture failure'); }")
        .then(() => "no error")
        .catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
    check("a thrown page error is rethrown with its message", thrown.includes("fixture failure"), thrown);
    const hung = await driver
        .evaluate(apiTab.id, "() => new Promise(() => {})", { deadlineMs: 200 })
        .then(() => "answered")
        .catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
    check("a call that never answers fails at its deadline", hung.includes("did not answer"), hung);
    const idle = await driver.waitForRequest(apiTab.id, { matches: () => true, timeoutMs: 300 });
    check("a request wait on an idle tab ends at its deadline", idle.request === null, `${idle.seen.length} seen`);
    const isQuery = (request: { url: string; headers: Record<string, string> }) =>
        request.url.endsWith("/api/query") &&
        request.headers.authorization === "Bearer fixture-token" &&
        request.headers["client-token"] === "fixture-client";
    const reloaded = await driver.waitForRequest(apiTab.id, { matches: isQuery, timeoutMs: 5000, cause: "reload" });
    check(
        "a reload makes the page send its request, and its headers are read lower-cased",
        reloaded.request !== null,
        reloaded.seen.join(", ")
    );
    const navigated = await driver.waitForRequest(apiTab.id, {
        matches: isQuery,
        timeoutMs: 5000,
        cause: { navigate: `${base}/api-page?again=1` },
    });
    check("a navigation cause is seen by the same wait", navigated.request !== null, navigated.seen.join(", "));
    // Two waits on one tab: the first ending must not switch Network off under the second.
    const shortWait = driver.waitForRequest(apiTab.id, { matches: () => false, timeoutMs: 200 });
    const longWait = driver.waitForRequest(apiTab.id, { matches: isQuery, timeoutMs: 5000 });
    await shortWait;
    await driver.evaluate(
        apiTab.id,
        "() => fetch('/api/query', { method: 'POST', headers: { Authorization: 'Bearer fixture-token', 'client-token': 'fixture-client' }, body: '{}' })"
    );
    const concurrent = await longWait;
    check("a wait still hears requests after another wait on the same tab ended", concurrent.request !== null);
    check("navigate waits for the load event", await driver.navigate(apiTab.id, `${base}/b`));
    await closeTab(port, apiTab.id);
    const gone = await driver
        .evaluate(apiTab.id, "document.title")
        .then(() => "answered")
        .catch((error: unknown) => error);
    check("a closed tab is reported as gone", gone instanceof TabGoneError, String(gone));
    driver.close();
    main.close();
    page.close();
} catch (error) {
    failures += 1;
    console.log(`FAIL  the guard run itself: ${error instanceof Error ? error.message : String(error)}`);
} finally {
    chrome.close();
    server.stop(true);
}

console.log(failures === 0 ? "all guard checks passed" : `${failures} guard check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
