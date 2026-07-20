import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { createCanvas, loadImage, type SKRSContext2D } from "@napi-rs/canvas";
import type { Annotation } from "./annotation-plan";
import { loadAnnotationPlanValue, renderAnnotationPlan } from "./render-plan";

const BASE = { r: 18, g: 52, b: 86 };

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

async function render(annotations: Annotation[], preset?: "review-red" | "callout-amber" | "redact") {
    return renderAnnotationPlan({ input: baseImage, annotations, preset });
}

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

        // label bg near (73,3)
        const [lr, lg, lb] = px(ctx, 75, 7);
        expect(lr + lg + lb).toBeLessThan(90);
    });

    test("grid labels:false draws lines only", async () => {
        const result = await render([{ kind: "grid", step: 100, originOffset: { x: 730, y: 415 }, labels: false }]);
        const { ctx } = await decode(result.png);
        const [lr, lg, lb] = px(ctx, 75, 7);
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
});
