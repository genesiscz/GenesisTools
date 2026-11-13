import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { LocatorSyntaxError, parseLocator, splitChain } from "@genesiscz/utils/chrome-devtools/shots/locator";
import {
    annotationOf,
    capturePart,
    DEFAULT_SETUP,
    describeMiss,
    type PageSetup,
    type Resolution,
    resolveLocators,
    SHOT_OVERLAY_ID,
    shotFrameArea,
    textRects,
} from "@genesiscz/utils/chrome-devtools/shots/page";
import { parseShotPart } from "@genesiscz/utils/chrome-devtools/shots/part";
import { type AnnotationRect, composeOverlay, encodeImage, validateAnnotations } from "@genesiscz/utils/image";
import { labelSpot } from "@genesiscz/utils/image/mark-layout";
import { SafeJSON } from "@genesiscz/utils/json";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { attach, type Page } from "../cdp";
import { cdpLikeOf } from "../cdp-like-adapter";
import { type HeadlessChrome, launchHeadlessChrome } from "../headless";
import { loadShotBook, parseShotBook, selectShots } from "./book";
import { imageFormatOf, loadWebPlan, shotFilesFor, takeQuickShot } from "./quick";
import { rehearseShots, runShots } from "./run";

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
        expect(role("heading", { name: "Zahrada" })).toBe('role=heading[name="Zahrada"]');
        expect(role("heading", { name: "Zahrada", exact: true })).toBe('role=heading[name="Zahrada"s]');
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

    test("a chain splits only at separators outside quotes and regex literals", () => {
        expect(splitChain('role=button[name="Next >> page"]')).toEqual(['role=button[name="Next >> page"]']);
        expect(splitChain('css=[title="a >> b"] >> nth=0')).toEqual(['css=[title="a >> b"]', "nth=0"]);
        expect(splitChain("text=/a >> [/] b/ >> nth=1")).toEqual(["text=/a >> [/] b/", "nth=1"]);
        expect(splitChain("text=Don't >> nth=1")).toEqual(["text=Don't", "nth=1"]);
        expect(parseLocator('role=button[name="Next >> page"]').chains[0]?.steps).toHaveLength(1);
    });

    test("a malformed locator fails at the boundary and names itself", () => {
        expect(() => parseLocator("tesid=x")).toThrow(LocatorSyntaxError);
        expect(() => parseLocator("tesid=x")).toThrow(/locator "tesid=x": unknown step/);
        expect(() => parseLocator("nth=1 >> testid=x")).toThrow(/cannot come first/);
        expect(() => parseLocator("text=/(/")).toThrow(/bad regular expression/);
        expect(() => parseLocator([])).toThrow(/empty union/);
        expect(() => parseLocator("role=heading[name=Zahrada]")).toThrow(/quoted/);
    });
});

const FIXTURE = `<!doctype html><html><head><style>
body { margin: 0; font: 16px Helvetica, Arial, sans-serif; }
.abs { position: absolute; margin: 0; }
</style></head><body>
<div data-testid="panel" class="abs" style="left:20px;top:20px;width:300px;height:200px">
  <h2 class="abs" style="left:10px;top:10px;font-size:20px">Zahrada SPOT</h2>
  <button data-testid="usages-button" class="abs" style="left:10px;top:150px;width:120px;height:30px">Kde je použitý</button>
</div>
<div data-testid="row-1" class="row abs" style="left:400px;top:20px;width:200px;height:40px">Šablona dopisu · <span data-testid="remove">Vyjmout</span></div>
<div data-testid="row-2" class="row abs" style="left:400px;top:80px;width:200px;height:40px">Jiný dokument · <span data-testid="remove">Vyjmout</span></div>
<div role="dialog" class="abs" style="left:20px;top:300px;width:300px;height:120px"><ul style="margin:0;padding:0;list-style:none"><li>ItemDto: typ</li><li>verze</li></ul></div>
<label for="name" class="abs" style="left:400px;top:300px">Název *</label>
<input id="name" class="abs" style="left:400px;top:330px;width:200px;height:24px">
<div data-testid="hidden-thing" style="display:none">skryté</div>
<div id="host" class="abs" style="left:700px;top:20px;width:100px;height:50px"></div>
<div data-testid="invisible" class="abs" style="left:900px;top:20px;width:40px;height:40px;visibility:hidden"><span data-testid="invisible-child" style="display:block;width:20px;height:20px"></span></div>
<div data-testid="mixed" class="abs" style="left:900px;top:100px;width:40px;height:40px"></div>
<div data-testid="mixed" class="abs" style="left:960px;top:200px;width:40px;height:40px;visibility:hidden"></div>
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
            text(/^Zahrada/),
            role("heading", { name: "zahrada" }),
            role("heading", { name: "Zahrada", exact: true }),
            role("dialog"),
            within(role("dialog"), css("li")),
            label(/^Název/),
            within(hasText(css(".row"), "šablona"), id("remove"))
        );

        expect(box(exact)).toEqual({ x: 30, y: 170, w: 120, h: 30, count: 1 });
        expect(box(contains)).toEqual(box(exact));
        expect(regex?.ok && regex.box.x).toBe(30);
        expect(heading?.ok && heading.count).toBe(1);
        expect(exactHeading).toEqual({ ok: false, source: 'role=heading[name="Zahrada"s]', reason: "none" });
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

    test("visibility:hidden matches are never boxed, and a chain step into a shadow host searches its root", async () => {
        const [invisible, invisibleChild, mixed, inHost] = await resolve(
            id("invisible"),
            id("invisible-child"),
            id("mixed"),
            within(css("#host"), css("span"))
        );

        expect(invisible).toEqual({ ok: false, source: "testid=invisible", reason: "zero-size" });
        expect(invisibleChild).toEqual({ ok: false, source: "testid=invisible-child", reason: "zero-size" });
        expect(box(mixed)).toEqual({ x: 900, y: 100, w: 40, h: 40, count: 1 });
        expect(box(inHost)).toEqual({ x: 700, y: 20, w: 60, h: 20, count: 1 });
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

    test("a quick shot writes the annotated image, the raw one and the marks, from a .jsonc web plan", async () => {
        const dir = mkdtempSync(join(tmpdir(), "quick-shot-"));
        const planPath = join(dir, "plan.jsonc");
        writeFileSync(
            planPath,
            `{
  // a mark on the page, and a pixel arrow on top of the final image
  "preset": "review-dashed",
  "clip": { "around": "testid=panel", "pad": 10 },
  "annotations": [
    { "target": "testid=usages-button", "at": "below", "label": "Kde je použitý" },
    { "kind": "arrow", "from": { "x": 200, "y": 20 }, "to": { "x": 120, "y": 60 } },
  ],
}`
        );
        const plan = await loadWebPlan(planPath);
        expect([plan.marks.length, plan.pixels.length, plan.clip?.pad]).toEqual([1, 1, 10]);

        const result = await takeQuickShot({ cdp, plan, out: join(dir, "usages.webp"), setup: SETUP, raw: true });
        if (!result.ok) {
            throw new Error(result.problems.join("; "));
        }

        expect(result.files).toEqual({
            annotated: join(dir, "usages.webp"),
            marks: join(dir, "usages.marks.json"),
            raw: join(dir, "usages.original.png"),
        });
        expect([existsSync(result.files.annotated), existsSync(join(dir, "usages.original.png"))]).toEqual([
            true,
            true,
        ]);
        const marks: unknown = SafeJSON.parse(readFileSync(result.files.marks, "utf8"), { strict: true });
        const annotations =
            marks && typeof marks === "object" && "annotations" in marks ? marks.annotations : undefined;
        validateAnnotations(annotations);
        expect(annotations.map((annotation) => annotation.kind)).toEqual(["highlight", "arrow"]);
    }, 30_000);

    test("a .ts web plan imports the locator helpers from @genesis-tools/shots", async () => {
        const dir = mkdtempSync(join(tmpdir(), "quick-plan-"));
        const planPath = join(dir, "plan.ts");
        writeFileSync(
            planPath,
            [
                'import { defineAnnotations, id, union } from "@genesis-tools/shots";',
                'export default defineAnnotations({ annotations: [{ target: union(id("panel"), id("row-1")), label: "x" }] });',
            ].join("\n")
        );
        const plan = await loadWebPlan(planPath);

        expect(plan.marks).toEqual([{ target: ["testid=panel", "testid=row-1"], label: "x" }]);
    });
});

describe("what a shot's overlay paints and exports", () => {
    test("an unfilled ellipse's painted area covers its whole curved stroke and not its middle", () => {
        const frame = {
            shape: "ellipse" as const,
            box: { x: 10, y: 20, w: 400, h: 200 },
            stroke: "#ff4d4f",
            strokeWidth: 3,
            dash: [],
            radius: 0,
            fill: "",
        };
        const areas = shotFrameArea(frame);
        const covered = (x: number, y: number) =>
            areas.some((area) => x >= area.x && x <= area.x + area.w && y >= area.y && y <= area.y + area.h);

        for (let degree = 0; degree < 360; degree += 3) {
            const angle = (degree * Math.PI) / 180;
            const x = 210 + (200 - 1.5) * Math.cos(angle);
            const y = 120 + (100 - 1.5) * Math.sin(angle);
            expect(covered(x, y)).toBe(true);
        }

        expect(covered(210, 120)).toBe(false);
        expect(covered(210 + 100, 120 + 50)).toBe(false);
    });

    test("the exported annotation carries the drawn style and the offset to where the chip was placed", () => {
        const placedChip = { x: 120, y: 20, w: 60, h: 18 };
        const annotation = annotationOf(
            {
                mark: { kind: "box", target: parseLocator("testid=x"), label: { text: "Here" } },
                frame: {
                    shape: "rect",
                    box: { x: 100, y: 50, w: 200, h: 100 },
                    stroke: "#ffb020",
                    strokeWidth: 3,
                    dash: [9, 6],
                    radius: 8,
                    fill: "",
                },
                chip: {
                    spec: { text: "Here", style: { bg: "#ffb020", fg: "#111111", fontSize: 14 }, at: placedChip },
                    placed: { chip: placedChip, position: "top-left", moved: true },
                },
            },
            { x: 0, y: 0, w: 800, h: 600 },
            2
        );

        if (annotation.kind !== "box") {
            throw new Error(`expected a box annotation, got ${annotation.kind}`);
        }

        expect(annotation.style).toEqual({ stroke: "#ffb020", strokeWidth: 6, radius: 16, fill: "", dash: [18, 12] });
        expect(annotation.label?.style).toEqual({ bg: "#ffb020", fg: "#111111", fontSize: 28 });
        const rect = { x: 200, y: 100, w: 400, h: 200 };
        const spot = labelSpot(
            { rect, size: { w: 120, h: 36 }, position: "top-left", gap: 8, offset: annotation.label?.offset },
            "top-left"
        );
        expect({ x: spot.x, y: spot.y }).toEqual({ x: 240, y: 40 });
    });
});

describe("the quick shot's output names", () => {
    test("only .png and .webp are image outputs, the marks sit beside the annotated one, and the raw only when asked", () => {
        expect([imageFormatOf("a/shot.PNG"), imageFormatOf("shot.webp"), imageFormatOf("proposal.shots.json")]).toEqual(
            ["png", "webp", null]
        );
        expect(shotFilesFor("/out/18-usages.1110.webp")).toEqual({
            annotated: "/out/18-usages.1110.webp",
            marks: "/out/18-usages.1110.marks.json",
        });
        expect(shotFilesFor("/out/18-usages.1110.webp", true).raw).toBe("/out/18-usages.1110.original.png");
    });

    test("a WebP wider than maxWidth is scaled down with its aspect ratio, a narrower one and a PNG are not", async () => {
        const canvas = createCanvas(1500, 100);
        canvas.getContext("2d").fillRect(0, 0, 1500, 100);
        const png = canvas.toBuffer("image/png");
        const sizeOf = async (image: Buffer) => {
            const loaded = await loadImage(image);
            return [loaded.width, loaded.height];
        };

        expect(await sizeOf(await encodeImage(png, "webp", { maxWidth: 1200, quality: 60 }))).toEqual([1200, 80]);
        expect(await sizeOf(await encodeImage(png, "webp", { maxWidth: 2000 }))).toEqual([1500, 100]);
        expect(await encodeImage(png, "png", { maxWidth: 1200 })).toBe(png);
    });
});

describe("a shot book", () => {
    const BOOK = {
        base: "http://127.0.0.1:1",
        shots: [
            {
                id: "18",
                stem: "18-usages",
                marks: [{ target: "testid=usages-button", at: "below", label: "Kde je použitý" }],
            },
            {
                id: "08",
                stem: "08-names",
                url: "/a",
                marks: [{ target: "testid=title" }],
                parts: [{ url: "/b", marks: [{ target: "testid=title" }] }],
            },
        ],
    };

    test("parses into shots with the script's defaults, and names the field of a mistake", () => {
        const book = parseShotBook(BOOK, "book.json");

        expect(book.use).toBe("headless");
        expect(book.browser.headless.cookies).toEqual({ from: "browser" });
        expect(book.setup).toMatchObject({
            settleMs: 1500,
            preset: "review-dashed",
            viewport: { width: 1440, height: 900, scale: 1 },
        });
        expect(book.output).toEqual({ formats: ["webp"], raw: false, webp: { maxWidth: 1200, quality: 60 } });
        expect(() => parseShotBook({ ...BOOK, output: { webp: { quality: 120 } } }, "book.json")).toThrow(
            /output\.webp\.quality: expected a number from 0 to 100, got 120/
        );
        expect(book.shots.map((shot) => [shot.id, shot.parts.length])).toEqual([
            ["18", 1],
            ["08", 2],
        ]);
        expect(selectShots(book, ["08-names"]).map((shot) => shot.id)).toEqual(["08"]);
        expect(() => selectShots(book, ["99"])).toThrow(/no shot named 99 .*ids: 18, 08/);
        expect(() => parseShotBook({ shots: [BOOK.shots[0], BOOK.shots[0]] }, "book.json")).toThrow(/used twice/);
        expect(() => parseShotBook({ shots: [{ ...BOOK.shots[0], stem: "a b" }] }, "book.json")).toThrow(/stem "a b"/);
        expect(() =>
            parseShotBook({ shots: [{ id: "1", stem: "one", marks: [{ target: "tesid=x" }] }] }, "book.json")
        ).toThrow(/locator "tesid=x": unknown step/);
    });

    test("a .ts book uses defineShots and the script's helpers, with no node_modules beside it", async () => {
        const dir = mkdtempSync(join(tmpdir(), "shot-book-"));
        const path = join(dir, "proposal.shots.ts");
        writeFileSync(
            path,
            [
                'import { defineShots, id, nth, text, union, within } from "@genesis-tools/shots";',
                'const section = (n: number) => nth(id("admin-section-inner-paper"), n);',
                "export default defineShots({",
                '    base: "http://localhost:3000",',
                "    shots: [{",
                '        id: "19", stem: "19-section-items", url: "/admin/categories/x", ready: section(1),',
                '        clip: { around: union(within(section(1), id("card")), text("Přidat položku")), pad: [30, 30, 60, 30] },',
                '        marks: [{ target: within(section(1), id("card")), at: "above", label: "Section.items: references" }],',
                "    }],",
                "});",
            ].join("\n")
        );
        const book = await loadShotBook(path, { base: "http://localhost:4000" });

        expect(book.base).toBe("http://localhost:4000");
        expect(book.shots[0].parts[0].ready?.source).toBe("testid=admin-section-inner-paper >> nth=1");
        expect(book.shots[0].parts[0].marks[0].label).toEqual({
            text: "Section.items: references",
            position: "top-left",
        });
    });
});

describe.skipIf(!HAS_CHROME)("running a shot book in headless Chrome", () => {
    const pages: Record<string, string> = {
        "/a": '<h2 data-testid="title" style="margin:20px;font:24px Helvetica">Zahrada</h2>',
        "/b": '<h2 data-testid="title" style="margin:20px;font:24px Helvetica">Servis kol</h2><p style="margin:20px">Popis produktu.</p>',
    };
    let server: ReturnType<typeof Bun.serve>;

    beforeAll(() => {
        server = Bun.serve({
            port: 0,
            fetch: (request) =>
                new Response(
                    `<!doctype html><html><body style="margin:0">${pages[new URL(request.url).pathname] ?? ""}</body></html>`,
                    {
                        headers: { "content-type": "text/html; charset=utf-8" },
                    }
                ),
        });
    });

    afterAll(() => {
        server?.stop(true);
    });

    function bookFor(marks: unknown[]) {
        return parseShotBook(
            {
                base: `http://127.0.0.1:${server.port}`,
                browser: { headless: { cookies: { from: "none" } } },
                page: { settleMs: 0, readyTimeoutMs: 5_000 },
                output: { formats: ["webp", "png"] },
                shots: [
                    {
                        id: "08",
                        stem: "08-names",
                        url: "/a",
                        ready: "testid=title",
                        marks,
                        parts: [{ url: "/b", ready: "testid=title", marks }],
                    },
                ],
            },
            "fixture-book.json"
        );
    }

    test("run writes the script's file names, stacks the two pages and keeps the marks of both", async () => {
        const out = mkdtempSync(join(tmpdir(), "shot-run-"));
        const report = await runShots(bookFor([{ target: "testid=title", at: "right", label: "název" }]), {
            tag: "1110",
            out,
            raw: true,
        });
        const result = report.results[0];
        if (result.status !== "ok") {
            throw new Error(result.problems.join("; "));
        }

        expect(result.files.map((file) => file.slice(out.length + 1))).toEqual([
            "08-names.1110.webp",
            "png/08-names.1110.png",
            "png/08-names.1110.original.png",
            ".shots/1110/08-names.marks.json",
        ]);
        const stacked = await loadImage(readFileSync(join(out, "png/08-names.1110.png")));
        const raw = await loadImage(readFileSync(join(out, "png/08-names.1110.original.png")));
        const webp = await loadImage(readFileSync(join(out, "08-names.1110.webp")));
        expect([stacked.width, stacked.height]).toEqual([raw.width, raw.height]);
        // the heading is a block, so the clip spans the 1440 px page: the WebP is scaled down to 1200 px
        expect(raw.width).toBe(1440);
        expect([webp.width, webp.height]).toEqual([1200, Math.round((raw.height * 1200) / 1440)]);
        const marks: unknown = SafeJSON.parse(readFileSync(join(out, ".shots/1110/08-names.marks.json"), "utf8"), {
            strict: true,
        });
        const annotations =
            marks && typeof marks === "object" && "annotations" in marks ? marks.annotations : undefined;
        validateAnnotations(annotations);
        const [first, second] = annotations;
        // the second page's mark sits below the first page in the stacked image
        expect(
            first.kind === "highlight" &&
                second.kind === "highlight" &&
                typeof first.rect === "object" &&
                typeof second.rect === "object" &&
                second.rect.y > first.rect.y + first.rect.h
        ).toBe(true);
        expect(existsSync(report.manifest)).toBe(true);
        expect(report.reproducible).toBe(true);
    }, 60_000);

    test("by default a run writes no raw image", async () => {
        const out = mkdtempSync(join(tmpdir(), "shot-run-"));
        const report = await runShots(bookFor([{ target: "testid=title" }]), { tag: "1110", out });
        const result = report.results[0];
        if (result.status !== "ok") {
            throw new Error(result.problems.join("; "));
        }

        expect(result.files.map((file) => file.slice(out.length + 1))).toEqual([
            "08-names.1110.webp",
            "png/08-names.1110.png",
            ".shots/1110/08-names.marks.json",
        ]);
        expect(existsSync(join(out, "png/08-names.1110.original.png"))).toBe(false);
    }, 60_000);

    test("rehearse names a target that matches nothing, and writes nothing", async () => {
        const results = await rehearseShots(bookFor([{ target: "testid=titel" }]), {});

        expect(results).toEqual([
            {
                status: "failed",
                id: "08",
                stem: "08-names",
                problems: [
                    "part 0 clip: testid=titel matched nothing",
                    "part 0 mark 0: testid=titel matched nothing",
                    "part 1 clip: testid=titel matched nothing",
                    "part 1 mark 0: testid=titel matched nothing",
                ],
            },
        ]);
    }, 60_000);
});
