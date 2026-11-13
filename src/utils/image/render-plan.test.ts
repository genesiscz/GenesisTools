import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { createCanvas, loadImage, type SKRSContext2D } from "@napi-rs/canvas";
import { ANNOTATION_PRESETS, type Annotation, type PresetName } from "./annotation-plan";
import { loadAnnotationPlanValue } from "./plan-file";
import { renderAnnotationPlan } from "./render-plan";

const BASE = { r: 18, g: 52, b: 86 };

/** Inside the first grid label's chip, outside its glyphs — see the grid tests below. */
const CHIP_PROBE = { x: 74, y: 4 };

function makeBase(): Buffer {
    const canvas = createCanvas(400, 300);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#123456";
    ctx.fillRect(0, 0, 400, 300);
    // hard vertical edge inside the blur-test region (300,200,60,60)
    ctx.fillStyle = "#000000";
    ctx.fillRect(300, 200, 30, 60);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(330, 200, 30, 60);
    return canvas.toBuffer("image/png");
}

const baseImage = makeBase();

async function decode(png: Buffer): Promise<{ width: number; height: number; ctx: SKRSContext2D }> {
    const img = await loadImage(png);
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    return { width: img.width, height: img.height, ctx };
}

function px(ctx: SKRSContext2D, x: number, y: number): [number, number, number, number] {
    const d = ctx.getImageData(x, y, 1, 1).data;
    return [d[0], d[1], d[2], d[3]];
}

function near(actual: number, expected: number, tolerance = 8): boolean {
    return Math.abs(actual - expected) <= tolerance;
}

async function render(annotations: Annotation[], preset?: PresetName) {
    return renderAnnotationPlan({ input: baseImage, annotations, preset });
}

describe("an annotation plan's preset names", () => {
    test("an inherited name such as toString or __proto__ is not a preset", async () => {
        for (const preset of ["toString", "constructor", "__proto__"]) {
            await expect(
                loadAnnotationPlanValue(
                    SafeJSON.stringify({ annotations: [{ kind: "box", rect: { x: 1, y: 1, w: 2, h: 2 } }], preset })
                )
            ).rejects.toThrow(/unknown preset/);
            await expect(
                loadAnnotationPlanValue(SafeJSON.stringify([{ kind: "box", rect: { x: 1, y: 1, w: 2, h: 2 }, preset }]))
            ).rejects.toThrow();
        }
    });
});

describe("renderAnnotationPlan", () => {
    test("highlight strokes review-red on the rect edge, leaves the rest untouched", async () => {
        const result = await render([{ kind: "highlight", rect: { x: 40, y: 40, w: 200, h: 120 } }]);
        const { ctx, width, height } = await decode(result.png);
        expect(width).toBe(400);
        expect(height).toBe(300);

        const [r, g, b] = px(ctx, 140, 40);
        expect(near(r, 255)).toBe(true);
        expect(near(g, 90)).toBe(true);
        expect(near(b, 95)).toBe(true);

        const [or, og, ob] = px(ctx, 350, 40);
        expect([or, og, ob]).toEqual([BASE.r, BASE.g, BASE.b]);
    });

    test("highlight fill wash tints the interior", async () => {
        const result = await render([{ kind: "highlight", rect: { x: 40, y: 40, w: 200, h: 120 } }]);
        const { ctx } = await decode(result.png);
        const [r, , b] = px(ctx, 140, 100);
        // rgba(255,90,95,0.08) over #123456 → red channel lifts, blue barely moves
        expect(r).toBeGreaterThan(BASE.r + 8);
        expect(near(b, BASE.b, 6)).toBe(true);
    });

    test("string rect form is accepted", async () => {
        const result = await render([{ kind: "highlight", rect: "40,40,200,120" }]);
        const { ctx } = await decode(result.png);
        const [r] = px(ctx, 140, 40);
        expect(near(r, 255)).toBe(true);
    });

    test("box has square corners where highlight is rounded", async () => {
        const rect = { x: 60, y: 60, w: 120, h: 80 };
        const boxed = await decode((await render([{ kind: "box", rect }])).png);
        const [br] = px(boxed.ctx, 60, 60);
        expect(near(br, 255)).toBe(true);

        const highlighted = await decode((await render([{ kind: "highlight", rect }])).png);
        const [hr, hg, hb] = px(highlighted.ctx, 60, 60);
        expect([hr, hg, hb]).toEqual([BASE.r, BASE.g, BASE.b]);
    });

    test("ellipse strokes the top center, not the bounding-rect corner", async () => {
        const result = await render([{ kind: "ellipse", rect: { x: 100, y: 100, w: 120, h: 80 } }]);
        const { ctx } = await decode(result.png);
        const [r] = px(ctx, 160, 100);
        expect(near(r, 255)).toBe(true);

        const [cr, cg, cb] = px(ctx, 100, 100);
        expect([cr, cg, cb]).toEqual([BASE.r, BASE.g, BASE.b]);
    });

    test("arrow paints its head at `to`", async () => {
        const result = await render([{ kind: "arrow", from: { x: 50, y: 250 }, to: { x: 200, y: 150 } }]);
        const { ctx } = await decode(result.png);
        const [r] = px(ctx, 195, 152);
        expect(r).toBeGreaterThan(150);
    });

    test("label chip paints bg + respects custom style", async () => {
        const result = await render([
            { kind: "label", at: { x: 50, y: 50 }, text: "①", style: { bg: "#111111", fg: "#ffffff", fontSize: 28 } },
        ]);
        const { ctx } = await decode(result.png);
        const [r, g, b] = px(ctx, 56, 56);
        expect(near(r, 17)).toBe(true);
        expect(near(g, 17)).toBe(true);
        expect(near(b, 17)).toBe(true);
    });

    // On macOS a bare `sans-serif` drew every Czech letter (á, č, ě, ř, š, ž) as a box. A real "č" is a "c" with a
    // caron above it: below the c's top the two labels differ by a few anti-aliased pixels (14 with Helvetica Neue).
    // A box glyph replaces the whole c, hundreds of pixels.
    test("label draws a letter with a caron, not a missing-glyph box", async () => {
        const style = { bg: "#111111", fg: "#ffffff", fontSize: 40 };
        const pixels = async (text: string) => {
            const { ctx } = await decode((await render([{ kind: "label", at: { x: 50, y: 50 }, text, style }])).png);
            return ctx.getImageData(0, 0, 400, 300).data;
        };
        const a = await pixels("c");
        const b = await pixels("č");
        let inkTop = -1;
        const diffRows: number[] = [];

        for (let y = 0; y < 300; y++) {
            for (let x = 0; x < 400; x++) {
                const i = (y * 400 + x) * 4;

                if (inkTop < 0 && a[i] > 128 && a[i + 1] > 128 && a[i + 2] > 128) {
                    inkTop = y;
                }

                if (Math.abs(a[i] - b[i]) > 8) {
                    diffRows.push(y);
                }
            }
        }

        expect(inkTop).toBeGreaterThan(0);
        expect(diffRows.filter((y) => y < inkTop).length).toBeGreaterThan(20);
        expect(diffRows.filter((y) => y > inkTop + 1).length).toBeLessThan(40);
    });

    test("blur softens the hard edge inside the rect and leaves the outside intact", async () => {
        const result = await render([{ kind: "blur", rect: { x: 300, y: 200, w: 60, h: 60 }, strength: 8 }]);
        const { ctx } = await decode(result.png);
        const [r, g, b] = px(ctx, 330, 230);
        // black|white boundary blurred → mid gray
        expect(r).toBeGreaterThan(40);
        expect(r).toBeLessThan(215);
        expect(g).toBeGreaterThan(40);
        expect(b).toBeGreaterThan(40);

        const [or, og, ob] = px(ctx, 200, 100);
        expect([or, og, ob]).toEqual([BASE.r, BASE.g, BASE.b]);
    });

    test("crop applies LAST regardless of array position", async () => {
        const result = await render([
            { kind: "crop", rect: { x: 20, y: 20, w: 200, h: 150 } },
            { kind: "highlight", rect: { x: 40, y: 40, w: 100, h: 60 } },
        ]);
        expect(result.width).toBe(200);
        expect(result.height).toBe(150);

        const { ctx } = await decode(result.png);
        // highlight edge at original (90,40) → cropped (70,20)
        const [r] = px(ctx, 70, 20);
        expect(near(r, 255)).toBe(true);
    });

    test("multiple crops warn and the last wins", async () => {
        const result = await render([
            { kind: "crop", rect: { x: 0, y: 0, w: 100, h: 100 } },
            { kind: "crop", rect: { x: 0, y: 0, w: 50, h: 40 } },
        ]);
        expect(result.width).toBe(50);
        expect(result.height).toBe(40);
        expect(result.warnings.some((w) => w.includes("crop"))).toBe(true);
    });

    test("crop outside the image throws; partially outside clamps with warning", async () => {
        await expect(render([{ kind: "crop", rect: { x: 500, y: 500, w: 100, h: 100 } }])).rejects.toThrow(/outside/);

        const clamped = await render([{ kind: "crop", rect: { x: 350, y: 250, w: 100, h: 100 } }]);
        expect(clamped.width).toBe(50);
        expect(clamped.height).toBe(50);
        expect(clamped.warnings.some((w) => w.includes("clamped"))).toBe(true);
    });

    test("grid draws origin-aligned lines and absolute labels", async () => {
        const result = await render([{ kind: "grid", step: 100, originOffset: { x: 730, y: 415 } }]);
        const { ctx } = await decode(result.png);
        // first vertical gridline: 800 global → 70 local
        const [r, g, b] = px(ctx, 70, 150);
        expect(r).toBeGreaterThan(100);
        expect(b).toBeGreaterThan(110);
        expect(g).toBeLessThan(60);

        // The label chip starts at (73,3) and the glyphs at (75,5), so (74,4) is the
        // one pixel that is chip background for ANY font: the old probe at (75,7) sat
        // under the first glyph, and whether the glyph covered it depended on which
        // sans-serif the host resolved — dark on macOS, part-lit on Linux.
        const [lr, lg, lb] = px(ctx, CHIP_PROBE.x, CHIP_PROBE.y);
        expect(lr + lg + lb).toBeLessThan(90);
    });

    test("grid labels:false draws lines only", async () => {
        const result = await render([{ kind: "grid", step: 100, originOffset: { x: 730, y: 415 }, labels: false }]);
        const { ctx } = await decode(result.png);
        const [lr, lg, lb] = px(ctx, CHIP_PROBE.x, CHIP_PROBE.y);
        expect([lr, lg, lb]).toEqual([BASE.r, BASE.g, BASE.b]);
    });

    test("style overrides preset per field", async () => {
        const result = await render(
            [{ kind: "highlight", rect: { x: 40, y: 40, w: 200, h: 120 }, style: { stroke: "#00ff00" } }],
            "review-red"
        );
        const { ctx } = await decode(result.png);
        const [r, g, b] = px(ctx, 140, 40);
        expect(near(g, 255)).toBe(true);
        expect(r).toBeLessThan(40);
        expect(b).toBeLessThan(40);
    });

    test("callout-amber preset strokes amber", async () => {
        const result = await render([{ kind: "box", rect: { x: 40, y: 40, w: 200, h: 120 } }], "callout-amber");
        const { ctx } = await decode(result.png);
        const [r, g, b] = px(ctx, 140, 40);
        expect(near(r, 255)).toBe(true);
        expect(near(g, 176)).toBe(true);
        expect(near(b, 32)).toBe(true);
    });

    test("redact preset blacks out boxes solid", async () => {
        const result = await render([{ kind: "box", rect: { x: 40, y: 40, w: 200, h: 120 } }], "redact");
        const { ctx } = await decode(result.png);
        const [r, g, b] = px(ctx, 140, 100);
        expect(near(r, 17)).toBe(true);
        expect(near(g, 17)).toBe(true);
        expect(near(b, 17)).toBe(true);
    });

    test("deterministic output — two renders are byte-identical", async () => {
        const plan: Annotation[] = [
            { kind: "highlight", rect: { x: 40, y: 40, w: 200, h: 120 }, label: { text: "Build pipeline" } },
            { kind: "arrow", from: { x: 300, y: 60 }, to: { x: 250, y: 100 } },
            { kind: "grid", step: 100 },
        ];
        const a = await render(plan);
        const b = await render(plan);
        expect(a.png.equals(b.png)).toBe(true);
    });

    test("unknown kind and empty annotations throw catalogs", async () => {
        await expect(
            renderAnnotationPlan({ input: baseImage, annotations: [{ kind: "sparkle" }] as unknown as Annotation[] })
        ).rejects.toThrow(/valid kinds: highlight, box/);
        await expect(renderAnnotationPlan({ input: baseImage, annotations: [] })).rejects.toThrow(/non-empty/);
    });

    test("zero-size shape rect throws", async () => {
        await expect(render([{ kind: "box", rect: { x: 10, y: 10, w: 0, h: 50 } }])).rejects.toThrow(/zero-size/);
    });

    test("a shape's own preset overrides the plan's, so red and amber marks share one plan", async () => {
        const result = await render([
            { kind: "box", rect: { x: 40, y: 40, w: 100, h: 60 } },
            { kind: "box", rect: { x: 200, y: 40, w: 100, h: 60 }, preset: "callout-amber" },
        ]);
        const { ctx } = await decode(result.png);
        const [rr, rg] = px(ctx, 90, 40);
        const [ar, ag, ab] = px(ctx, 250, 40);
        expect(near(rr, 255) && near(rg, 90)).toBe(true);
        expect(near(ar, 255) && near(ag, 176) && near(ab, 32)).toBe(true);
    });

    test("every preset's label chip has readable text: 4.5:1, or 3:1 for bold text of 18.66 px and more", () => {
        const luminance = (hex: string): number => {
            const [r, g, b] = [1, 3, 5].map((at) => {
                const channel = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
                return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
            });
            return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const contrast = (a: string, b: string): number => {
            const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
            return (light + 0.05) / (dark + 0.05);
        };
        const unreadable = Object.entries(ANNOTATION_PRESETS).flatMap(([name, preset]) => {
            const { bg, fg, fontSize } = preset.labelChip;
            const ratio = contrast(bg, fg);
            return ratio < (fontSize >= 18.66 ? 3 : 4.5) ? [`${name} ${fg} on ${bg}: ${ratio.toFixed(2)}`] : [];
        });

        expect(unreadable).toEqual([]);
    });

    test("review-dashed strokes a dashed outline: red dashes with gaps of the page between them", async () => {
        const result = await render([{ kind: "box", rect: { x: 40, y: 100, w: 200, h: 60 } }], "review-dashed");
        const { ctx } = await decode(result.png);
        let dash = 0;
        let gap = 0;

        for (let x = 50; x < 230; x += 1) {
            const [r, g, b] = px(ctx, x, 100);

            if (near(r, 255) && near(g, 77, 12)) {
                dash += 1;
            } else if (r === BASE.r && g === BASE.g && b === BASE.b) {
                gap += 1;
            }
        }

        expect(dash).toBeGreaterThan(40);
        expect(gap).toBeGreaterThan(40);
    });

    test("a label with a line break is a taller chip", async () => {
        const style = { bg: "#111111", fg: "#ffffff", fontSize: 20 };
        const one = await decode((await render([{ kind: "label", at: { x: 50, y: 50 }, text: "one", style }])).png);
        const two = await decode(
            (await render([{ kind: "label", at: { x: 50, y: 50 }, text: "one\ntwo", style }])).png
        );
        // 32 px for one line, 26 px more for the second: y 100 is chip in the two-line label only
        expect(px(one.ctx, 52, 100).slice(0, 3)).toEqual([BASE.r, BASE.g, BASE.b]);
        expect(near(px(two.ctx, 52, 100)[0], 17)).toBe(true);
    });

    test("a right label stands off its shape and a leader line joins them", async () => {
        const result = await render([
            { kind: "highlight", rect: { x: 60, y: 120, w: 80, h: 40 }, label: { text: "x", position: "right" } },
        ]);
        const { ctx } = await decode(result.png);
        // the leader crosses the 36 px between the shape's right edge (x 140) and the chip
        const [r, g, b] = px(ctx, 158, 140);
        expect(near(r, 255) && near(g, 90) && near(b, 95)).toBe(true);
        expect(px(ctx, 158, 125).slice(0, 3)).toEqual([BASE.r, BASE.g, BASE.b]);
    });

    test("a label that would leave the image moves below its shape instead of covering it", async () => {
        const result = await render([
            { kind: "highlight", rect: { x: 40, y: 2, w: 200, h: 60 }, label: { text: "Build", position: "top-left" } },
        ]);
        const { ctx } = await decode(result.png);
        // below the shape: y 62 + gap 6 = 68
        const [r, g] = px(ctx, 44, 72);
        expect(near(r, 255) && near(g, 90)).toBe(true);
        expect(px(ctx, 50, 20)[0]).toBeLessThan(120);
        expect(result.warnings).toEqual([]);
    });

    test("a second label at the same spot moves to the next free one", async () => {
        const rect = { x: 100, y: 150, w: 150, h: 60 };
        const result = await render([
            { kind: "box", rect, label: { text: "first", style: { bg: "#00ff00" } } },
            { kind: "box", rect, label: { text: "second", style: { bg: "#0000ff" } } },
        ]);
        const { ctx } = await decode(result.png);
        const [, firstG] = px(ctx, 104, 110);
        const [, , secondB] = px(ctx, 104, 220);
        expect(near(firstG, 255)).toBe(true);
        expect(near(secondB, 255)).toBe(true);
    });

    test("a label that fits nowhere is drawn clamped and named in a warning", async () => {
        const result = await render([
            {
                kind: "box",
                rect: { x: 40, y: 40, w: 100, h: 60 },
                label: { text: "a label far wider than the whole picture", style: { fontSize: 60 } },
            },
        ]);
        expect(result.warnings).toEqual([
            'label "a label far wider than the whole picture" fits nowhere free in the image; drawn at top-left',
        ]);
    });

    test("an item with a page target is refused: only a live page can resolve it", async () => {
        await expect(
            render([{ kind: "box", target: "testid=usages-button" }] as unknown as Annotation[])
        ).rejects.toThrow(/names a target \(a page locator\)/);
    });

    test("an unknown label position or shape preset throws with the valid list", async () => {
        await expect(
            render([
                { kind: "box", rect: { x: 1, y: 1, w: 5, h: 5 }, label: { text: "x", position: "middle" } },
            ] as unknown as Annotation[])
        ).rejects.toThrow(/valid positions: top-left, top-right/);
        await expect(
            render([{ kind: "box", rect: { x: 1, y: 1, w: 5, h: 5 }, preset: "neon" }] as unknown as Annotation[])
        ).rejects.toThrow(/valid presets: review-red/);
    });
});

describe("loadAnnotationPlanValue", () => {
    test("inline object and bare-array shorthand", async () => {
        const obj = await loadAnnotationPlanValue(
            SafeJSON.stringify({ annotations: [{ kind: "box", rect: { x: 1, y: 1, w: 5, h: 5 } }], preset: "redact" })
        );
        expect(obj.preset).toBe("redact");
        expect(obj.annotations).toHaveLength(1);

        const arr = await loadAnnotationPlanValue(
            SafeJSON.stringify([{ kind: "label", at: { x: 1, y: 1 }, text: "x" }])
        );
        expect(arr.annotations).toHaveLength(1);
    });

    test("plan file path", async () => {
        const dir = mkdtempSync(join(tmpdir(), "annotate-plan-"));
        const planPath = join(dir, "plan.json");
        writeFileSync(
            planPath,
            SafeJSON.stringify({ annotations: [{ kind: "box", rect: { x: 1, y: 1, w: 5, h: 5 } }] })
        );
        const plan = await loadAnnotationPlanValue(planPath);
        expect(plan.annotations).toHaveLength(1);
    });

    test("missing file and unknown preset throw", async () => {
        await expect(loadAnnotationPlanValue("/nope/plan.json")).rejects.toThrow(/not found/);
        await expect(
            loadAnnotationPlanValue(SafeJSON.stringify({ annotations: [{ kind: "grid" }], preset: "neon" }))
        ).rejects.toThrow(/valid presets/);
    });

    test("a .jsonc plan may carry comments and trailing commas", async () => {
        const dir = mkdtempSync(join(tmpdir(), "annotate-plan-"));
        const planPath = join(dir, "plan.jsonc");
        writeFileSync(
            planPath,
            '{\n  // the usages button\n  "preset": "review-dashed",\n  "annotations": [\n    { "kind": "box", "rect": { "x": 1, "y": 1, "w": 5, "h": 5 }, },\n  ],\n}\n'
        );
        const plan = await loadAnnotationPlanValue(planPath);
        expect(plan.preset).toBe("review-dashed");
        expect(plan.annotations).toHaveLength(1);
    });

    test("a .ts plan imports defineAnnotations from the module the loader serves", async () => {
        const dir = mkdtempSync(join(tmpdir(), "annotate-plan-"));
        const planPath = join(dir, "plan.ts");
        writeFileSync(
            planPath,
            [
                'import { defineAnnotations } from "@genesis-tools/annotate";',
                'const box = (x: number) => ({ kind: "box" as const, rect: { x, y: 1, w: 5, h: 5 } });',
                'export default defineAnnotations({ preset: "info-blue", annotations: [box(1), box(20)] });',
            ].join("\n")
        );
        // Bun's resolver caches a folder's entries at the first import from it, so both files exist before that
        const empty = join(dir, "empty.ts");
        writeFileSync(empty, "export const nothing = 1;\n");

        const plan = await loadAnnotationPlanValue(planPath);
        expect(plan.preset).toBe("info-blue");
        expect(plan.annotations).toHaveLength(2);
        await expect(loadAnnotationPlanValue(empty)).rejects.toThrow(/no default export/);
    });
});
