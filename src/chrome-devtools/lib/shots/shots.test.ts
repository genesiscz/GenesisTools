import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import type { CdpLike } from "@genesiscz/utils/chrome-devtools/cdp-like";
import { evaluateExpression } from "@genesiscz/utils/chrome-devtools/evaluate";
import {
    css,
    hasText,
    id,
    idPrefix,
    label,
    nth,
    role,
    text,
    union,
    within,
} from "@genesiscz/utils/chrome-devtools/shots/kit";
import { LocatorSyntaxError, parseLocator } from "@genesiscz/utils/chrome-devtools/shots/locator";
import {
    describeMiss,
    type Resolution,
    resolveLocators,
    SHOT_OVERLAY_ID,
    textRects,
} from "@genesiscz/utils/chrome-devtools/shots/page";
import { SafeJSON } from "@genesiscz/utils/json";
import { attach, type Page } from "../cdp";
import { cdpLikeOf } from "../cdp-like-adapter";
import { type HeadlessChrome, launchHeadlessChrome } from "../headless";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const HAS_CHROME = process.platform === "darwin" && existsSync(CHROME);

describe("the locator grammar", () => {
    test("the kit builds the script's helpers as locator strings", () => {
        expect(id("usages-button")).toBe("testid=usages-button");
        expect(text("Katalog produktů")).toBe("text=Katalog produktů >> nth=0");
        expect(text("použitý", false)).toBe("text~=použitý >> nth=0");
        expect(text(/^Sekce: \d+$/)).toBe("text=/^Sekce: \\d+$/ >> nth=0");
        expect(union(id("a"), [id("b"), id("c")])).toEqual(["testid=a", "testid=b", "testid=c"]);
        expect(within(nth(id("section"), 1), id("card"))).toBe("testid=section >> nth=1 >> testid=card");
        expect(hasText(id("row"), "Šablona")).toBe("testid=row >> has-text=Šablona");
        expect(role("heading", { name: "Elektřina" })).toBe('role=heading[name="Elektřina"]');
        expect(role("heading", { name: "Elektřina", exact: true })).toBe('role=heading[name="Elektřina"s]');
        // a regex literal's source may come back with \u escapes (Bun writes á as á); both forms match the same
        expect(label(/^Název/)).toBe("label=/^Název/");
    });

    test("a chain parses into steps, and a union keeps each member's source", () => {
        expect(parseLocator(within(nth(id("section"), 1), css("li"))).chains[0].steps).toEqual([
            { engine: "testid", match: { kind: "exact", text: "section" } },
            { engine: "nth", index: 1 },
            { engine: "css", selector: "li" },
        ]);
        expect(parseLocator(role("heading", { name: /^El/i })).chains[0].steps).toEqual([
            { engine: "role", role: "heading", name: { kind: "regex", source: "^El", flags: "i" } },
        ]);
        const both = parseLocator(union(id("a"), idPrefix("row-")));
        expect(both.source).toBe("testid=a | testid^=row-");
        expect(both.chains.map((chain) => chain.source)).toEqual(["testid=a", "testid^=row-"]);
    });

    test("a malformed locator fails at the boundary and names itself", () => {
        expect(() => parseLocator("tesid=x")).toThrow(LocatorSyntaxError);
        expect(() => parseLocator("tesid=x")).toThrow(/locator "tesid=x": unknown step/);
        expect(() => parseLocator("nth=1 >> testid=x")).toThrow(/cannot come first/);
        expect(() => parseLocator("text=/(/")).toThrow(/bad regular expression/);
        expect(() => parseLocator([])).toThrow(/empty union/);
        expect(() => parseLocator("role=heading[name=Elektřina]")).toThrow(/quoted/);
    });
});

const FIXTURE = `<!doctype html><html><head><style>
body { margin: 0; font: 16px Helvetica, Arial, sans-serif; }
.abs { position: absolute; margin: 0; }
</style></head><body>
<div data-testid="panel" class="abs" style="left:20px;top:20px;width:300px;height:200px">
  <h2 class="abs" style="left:10px;top:10px;font-size:20px">Elektřina SPOT</h2>
  <button data-testid="usages-button" class="abs" style="left:10px;top:150px;width:120px;height:30px">Kde je použitý</button>
</div>
<div data-testid="row-1" class="row abs" style="left:400px;top:20px;width:200px;height:40px">Šablona leadu · <span data-testid="remove">Vyjmout</span></div>
<div data-testid="row-2" class="row abs" style="left:400px;top:80px;width:200px;height:40px">Jiný dokument · <span data-testid="remove">Vyjmout</span></div>
<div role="dialog" class="abs" style="left:20px;top:300px;width:300px;height:120px"><ul style="margin:0;padding:0;list-style:none"><li>UsageDto: typ</li><li>verze</li></ul></div>
<label for="name" class="abs" style="left:400px;top:300px">Název *</label>
<input id="name" class="abs" style="left:400px;top:330px;width:200px;height:24px">
<div data-testid="hidden-thing" style="display:none">skryté</div>
<div id="host" class="abs" style="left:700px;top:20px;width:100px;height:50px"></div>
</body></html>`;

const SHADOW = `document.getElementById("host").attachShadow({ mode: "open" }).innerHTML =
    '<span data-testid="in-shadow" style="display:block;width:60px;height:20px">stín</span>'`;

describe.skipIf(!HAS_CHROME)("locators in a real page", () => {
    let chrome: HeadlessChrome;
    let page: Page;
    let cdp: CdpLike;

    beforeAll(async () => {
        chrome = await launchHeadlessChrome();
        page = await attach({ port: chrome.port });
        cdp = cdpLikeOf(page);
        await evaluateExpression(
            cdp,
            `document.open(); document.write(${SafeJSON.stringify(FIXTURE)}); document.close();`
        );
        await evaluateExpression(cdp, SHADOW);
    }, 30_000);

    afterAll(async () => {
        page?.close();
        await chrome?.close();
    }, 30_000);

    async function resolve(...sources: Array<string | string[]>): Promise<Resolution[]> {
        return resolveLocators(cdp, sources.map(parseLocator));
    }

    function box(resolution: Resolution | undefined) {
        return resolution?.ok ? { ...resolution.box, count: resolution.count } : resolution;
    }

    test("test ids, prefixes, unions, nth and scoped children resolve to document boxes", async () => {
        const [button, both, rows, lastRemove, removeInRow1] = await resolve(
            id("usages-button"),
            union(id("panel"), id("row-1")),
            idPrefix("row-"),
            nth(id("remove"), -1),
            within(id("row-1"), id("remove"))
        );

        expect(box(button)).toEqual({ x: 30, y: 170, w: 120, h: 30, count: 1 });
        expect(box(both)).toEqual({ x: 20, y: 20, w: 580, h: 200, count: 2 });
        expect(box(rows)).toEqual({ x: 400, y: 20, w: 200, h: 100, count: 2 });
        expect(lastRemove?.ok && lastRemove.box.y).toBeGreaterThanOrEqual(80);
        expect(removeInRow1?.ok && removeInRow1.count).toBe(1);
        expect(removeInRow1?.ok && removeInRow1.box.y).toBeLessThan(60);
    });

    test("text, role, label and has-text find what Playwright's getBy calls found", async () => {
        const [exact, contains, regex, heading, exactHeading, dialog, items, field, row] = await resolve(
            text("Kde je použitý"),
            text("POUŽITÝ", false),
            text(/^Elektřina/),
            role("heading", { name: "elektřina" }),
            role("heading", { name: "Elektřina", exact: true }),
            role("dialog"),
            within(role("dialog"), css("li")),
            label(/^Název/),
            within(hasText(css(".row"), "šablona"), id("remove"))
        );

        expect(box(exact)).toEqual({ x: 30, y: 170, w: 120, h: 30, count: 1 });
        expect(box(contains)).toEqual(box(exact));
        expect(regex?.ok && regex.box.x).toBe(30);
        expect(heading?.ok && heading.count).toBe(1);
        expect(exactHeading).toEqual({ ok: false, source: 'role=heading[name="Elektřina"s]', reason: "none" });
        expect(box(dialog)).toEqual({ x: 20, y: 300, w: 300, h: 120, count: 1 });
        expect(items?.ok && items.count).toBe(2);
        expect(field?.ok && [field.box.x, field.box.y]).toEqual([400, 330]);
        expect(row?.ok && row.box.y).toBeLessThan(60);
    });

    test("an open shadow root is searched, and a miss is named, never boxed at 0,0", async () => {
        const [shadow, missing, hidden] = await resolve(
            id("in-shadow"),
            union(id("panel"), id("usages-buton")),
            id("hidden-thing")
        );

        expect(box(shadow)).toEqual({ x: 700, y: 20, w: 60, h: 20, count: 1 });
        expect(missing).toEqual({
            ok: false,
            source: "testid=panel | testid=usages-buton",
            reason: "none",
            member: "testid=usages-buton",
        });
        expect(missing?.ok === false && describeMiss(missing)).toBe(
            "testid=panel | testid=usages-buton (member testid=usages-buton) matched nothing"
        );
        expect(hidden).toEqual({ ok: false, source: "testid=hidden-thing", reason: "zero-size" });
    });

    test("text boxes inside a clip are the obstacles, and the overlay's own text is not one", async () => {
        await evaluateExpression(
            cdp,
            `(() => { const o = document.createElement("div"); o.id = "${SHOT_OVERLAY_ID}";
              o.style.cssText = "position:absolute;left:420px;top:130px"; o.textContent = "label chip";
              document.body.appendChild(o); })()`
        );
        const boxes = await textRects(cdp, { x: 380, y: 0, w: 300, h: 160 });

        expect(boxes.length).toBeGreaterThanOrEqual(4);
        expect(boxes.every((rect) => rect.x >= 380 && rect.y < 160)).toBe(true);
        expect(boxes.some((rect) => rect.y >= 125)).toBe(false);
    });
});
