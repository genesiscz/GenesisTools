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
    capturePart,
    DEFAULT_SETUP,
    describeMiss,
    type PageSetup,
    type Resolution,
    resolveLocators,
    SHOT_OVERLAY_ID,
    textRects,
} from "@genesiscz/utils/chrome-devtools/shots/page";
import { parseShotPart } from "@genesiscz/utils/chrome-devtools/shots/part";
import { type AnnotationRect, composeOverlay, validateAnnotations } from "@genesiscz/utils/image";
import { SafeJSON } from "@genesiscz/utils/json";
import { createCanvas, loadImage } from "@napi-rs/canvas";
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
        // built from a string: Bun prints a regex literal's non-ASCII letters as escapes, which match the same
        const named = "^Název";
        expect(label(new RegExp(named))).toBe("label=/^Název/");
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

    test("a mark in the first script's words becomes an annotation with a locator", () => {
        const part = parseShotPart({
            marks: [
                { target: id("x"), at: "below", dy: 22, color: "amber", quiet: true, label: "Kde je použitý" },
                { target: union(id("a"), id("b")) },
            ],
        });

        expect(part.marks[0]).toEqual({
            kind: "highlight",
            target: parseLocator("testid=x"),
            label: { text: "Kde je použitý", position: "bottom-left", offset: { x: 0, y: 22 } },
            preset: "callout-amber-dashed",
            style: { strokeWidth: 0, fill: "" },
        });
        // no clip: the union of every mark's target, 20 px around it
        expect(part.clip.around.chains.map((chain) => chain.source)).toEqual(["testid=x", "testid=a", "testid=b"]);
        expect(part.clip.pad).toEqual([20, 20, 20, 20]);
        expect(() => parseShotPart({ marks: [{ target: id("x"), at: "under" as "below" }] })).toThrow(/unknown side/);
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

    const SETUP: PageSetup = {
        ...DEFAULT_SETUP,
        settleMs: 0,
        readyTimeoutMs: 2_000,
        viewport: { width: 1000, height: 800, scale: 1 },
    };

    async function pixels(png: Buffer): Promise<{ width: number; height: number; data: Uint8ClampedArray }> {
        const image = await loadImage(png);
        const canvas = createCanvas(image.width, image.height);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(image, 0, 0);
        return {
            width: image.width,
            height: image.height,
            data: ctx.getImageData(0, 0, image.width, image.height).data,
        };
    }

    /** Pixels where a and b differ, split by whether they lie inside one of `areas`. */
    async function differences(a: Buffer, b: Buffer, areas: readonly AnnotationRect[]) {
        const [left, right] = await Promise.all([pixels(a), pixels(b)]);
        let inside = 0;
        let outside = 0;
        const outsideAt: Array<[number, number]> = [];
        for (let y = 0; y < left.height; y += 1) {
            for (let x = 0; x < left.width; x += 1) {
                const i = (y * left.width + x) * 4;
                const same =
                    left.data[i] === right.data[i] &&
                    left.data[i + 1] === right.data[i + 1] &&
                    left.data[i + 2] === right.data[i + 2];
                if (same) {
                    continue;
                }

                const covered = areas.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
                if (covered) {
                    inside += 1;
                } else {
                    outside += 1;
                    if (outsideAt.length < 12) {
                        outsideAt.push([x, y]);
                    }
                }
            }
        }

        return { inside, outside, outsideAt };
    }

    test("the annotated shot differs from the raw one only under the overlay, drawn in the page's font", async () => {
        const part = parseShotPart({
            clip: { around: union(id("panel"), role("dialog")), fit: "labels" },
            marks: [
                { target: id("usages-button"), at: "below", label: "Kde je použitý: GET …/usages" },
                { target: role("dialog"), at: "bottom-right", color: "amber", label: "dialog\nsecond line" },
            ],
        });
        const capture = await capturePart(cdp, part, SETUP);
        if (!capture.ok) {
            throw new Error(capture.problems.join("; "));
        }

        const { images } = capture;
        // the dialog's label hangs below the 440 px of the clip's union, so fit: "labels" grew the clip to hold it
        expect(images.clip.h).toBeGreaterThan(440);
        expect([images.width, images.height]).toEqual([images.clip.w, images.clip.h]);

        // every pixel the overlay changed lies in a painted area, so the composed image keeps all of the overlay
        const direct = await differences(images.raw, images.annotated, images.painted);
        expect(direct.outsideAt).toEqual([]);
        expect(direct.inside).toBeGreaterThan(500);
        const composed = await composeOverlay(images);
        expect((await differences(composed, images.annotated, [])).outside).toBe(0);

        expect(images.font).toBe(String(await evaluateExpression(cdp, "getComputedStyle(document.body).fontFamily")));
        validateAnnotations(images.annotations);
        expect(images.annotations[1]).toMatchObject({ kind: "highlight", preset: "callout-amber-dashed" });
        expect(images.annotations[1].kind === "highlight" && images.annotations[1].label?.position).toBe(
            "bottom-right"
        );
        expect(await evaluateExpression(cdp, `!!document.getElementById("${SHOT_OVERLAY_ID}")`)).toBe(false);
    }, 30_000);

    test("a label with no free spot inside the clip fails the part and names the label", async () => {
        const part = parseShotPart({
            clip: { around: id("usages-button"), pad: 0 },
            marks: [
                { target: id("usages-button"), at: "below", label: "Kde je použitý: a label wider than its button" },
            ],
        });
        const capture = await capturePart(cdp, part, SETUP);

        expect(capture.ok).toBe(false);
        expect(!capture.ok && capture.problems[0]).toMatch(
            /^mark 0 label "Kde je použitý: a label wider than its button": no free spot inside the clip/
        );
    }, 30_000);

    test("a target that matches nothing fails the part before anything is drawn", async () => {
        const capture = await capturePart(cdp, parseShotPart({ marks: [{ target: id("usages-buton") }] }), SETUP);

        expect(capture).toEqual({
            ok: false,
            problems: ["clip: testid=usages-buton matched nothing", "mark 0: testid=usages-buton matched nothing"],
        });
        expect(await evaluateExpression(cdp, `!!document.getElementById("${SHOT_OVERLAY_ID}")`)).toBe(false);
    }, 30_000);
});
