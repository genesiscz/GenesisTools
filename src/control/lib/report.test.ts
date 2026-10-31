import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeRgbaToPng } from "@genesiscz/utils/image";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    classifyRegions,
    orderLines,
    pairsInFolder,
    parseShotList,
    previewOpenCommand,
    renderReportMarkdown,
    reportPair,
} from "./report";

type Rect = { x: number; y: number; w: number; h: number };

/** A 200x120 grey screen with dark boxes painted on it, as PNG bytes. */
function screen(boxes: Rect[]): Buffer {
    const width = 200;
    const height = 120;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        data.set([230, 230, 230, 255], i * 4);
    }

    for (const box of boxes) {
        for (let y = box.y; y < box.y + box.h; y++) {
            for (let x = box.x; x < box.x + box.w; x++) {
                data.set([30, 30, 30, 255], (y * width + x) * 4);
            }
        }
    }

    return encodeRgbaToPng(data, width, height);
}

function treeJson(button: Rect): string {
    return SafeJSON.stringify({
        version: 1,
        face: "hub",
        source: "ax",
        window: { width: 200, height: 120 },
        nodes: [
            { path: "AXWindow", role: "AXWindow", depth: 0, hasLabel: true, frame: { x: 0, y: 0, w: 200, h: 120 } },
            {
                path: "AXWindow/AXButton[0]",
                role: "AXButton",
                identifier: "save",
                depth: 1,
                hasLabel: true,
                frame: button,
            },
        ],
    });
}

function geometryJson(width: number, height: number): string {
    return SafeJSON.stringify({
        version: 1,
        face: "hub",
        window: { width, height },
        scale: 1,
        backingScale: 1,
        image: { width, height },
        build: { binary: "00000000-0000-0000-0000-000000000000", commit: null, commitSource: "unknown" },
        capturedAt: "2026-10-30T19:53:20Z",
    });
}

const title = { x: 20, y: 20, w: 60, h: 10 };
const longerTitle = { x: 20, y: 20, w: 90, h: 10 };
const buttonBefore = { x: 140, y: 80, w: 40, h: 20 };
const buttonAfter = { x: 140, y: 50, w: 40, h: 20 };

async function writePair(folder: string, stem: string, { tree }: { tree: boolean }): Promise<void> {
    await Bun.write(join(folder, `${stem}-before.png`), screen([title, buttonBefore]));
    await Bun.write(join(folder, `${stem}-after.png`), screen([longerTitle, buttonAfter]));
    if (tree) {
        await Bun.write(join(folder, `${stem}-before.tree.json`), treeJson(buttonBefore));
        await Bun.write(join(folder, `${stem}-after.tree.json`), treeJson(buttonAfter));
    }
}

const options = (outDir: string) => ({ outDir, threshold: 0.1, mergeDistance: 6, minArea: 4 });

describe("control report", () => {
    it("colours the moved control red and the longer title amber when both shots have a view tree", async () => {
        const folder = mkdtempSync(join(tmpdir(), "control-report-"));
        await writePair(folder, "sessions", { tree: true });

        const result = await reportPair(
            {
                screen: "sessions",
                before: join(folder, "sessions-before.png"),
                after: join(folder, "sessions-after.png"),
            },
            1,
            options(join(folder, "out"))
        );

        expect(result.status).toBe("ok");
        expect(result.tree?.changes.map((change) => `${change.kind} ${change.key}`)).toEqual(["moved #save"]);
        // The button's old spot and its new spot are two red regions; the longer title is one amber region.
        expect(result.regions.map((region) => region.kind).sort()).toEqual(["change", "change", "data"]);
        expect(result.beforeOut).toBe(join(folder, "out", "01-sessions-1-before.png"));
        expect(result.afterOut).toBe(join(folder, "out", "01-sessions-2-after.png"));
        expect(await Bun.file(result.afterOut ?? "").exists()).toBe(true);
    });

    it("marks every region red without a view tree, and refuses another point size", async () => {
        const folder = mkdtempSync(join(tmpdir(), "control-report-"));
        await writePair(folder, "inbox", { tree: false });
        const pair = {
            screen: "inbox",
            before: join(folder, "inbox-before.png"),
            after: join(folder, "inbox-after.png"),
        };

        const plain = await reportPair(pair, 2, options(join(folder, "out")));
        expect(plain.regions.length).toBeGreaterThan(0);
        expect(plain.regions.every((region) => region.kind === "change")).toBe(true);

        await Bun.write(join(folder, "inbox-before.geometry.json"), geometryJson(200, 120));
        await Bun.write(join(folder, "inbox-after.geometry.json"), geometryJson(400, 240));
        const refused = await reportPair(pair, 2, options(join(folder, "out")));
        expect(refused.status).toBe("refused");
        expect(refused.message).toContain("200");
        expect(refused.message).toContain("400");
    });

    it("encodes image paths with spaces and parentheses in Markdown", () => {
        const markdown = renderReportMarkdown({
            title: "Comparison",
            notePath: "/tmp/report/note.md",
            openCommand: "open",
            writtenAt: "2026-10-30 21:00",
            results: [
                {
                    screen: "fixture",
                    index: 1,
                    status: "ok",
                    regions: [],
                    before: "a",
                    after: "b",
                    beforeOut: "/tmp/Before After/(pair)/one.png",
                    afterOut: "/tmp/Before After/(pair)/two.png",
                },
            ],
        });
        expect(markdown).toContain("![before](../Before%20After/%28pair%29/one.png)");
    });

    it("classifies a region by overlap with a tree change", () => {
        const regions = [
            { x: 140, y: 50, w: 40, h: 50, pixels: 800 },
            { x: 20, y: 20, w: 90, h: 10, pixels: 300 },
        ];
        const tree = {
            matched: 2,
            dataOnly: [],
            changes: [
                {
                    kind: "moved" as const,
                    key: "#save",
                    role: "AXButton",
                    before: buttonBefore,
                    after: buttonAfter,
                },
            ],
        };

        expect(classifyRegions({ regions, tree, scale: 1 }).map((region) => region.kind)).toEqual(["change", "data"]);
        expect(classifyRegions({ regions, tree: undefined, scale: 1 }).map((region) => region.kind)).toEqual([
            "change",
            "change",
        ]);
    });

    it("reads a shot list and a folder of pairs, and writes the note, the order and the open command", async () => {
        const folder = mkdtempSync(join(tmpdir(), "control-report-"));
        await writePair(folder, "01-agents", { tree: false });
        await Bun.write(join(folder, "02-lonely-before.png"), screen([]));

        const pairs = await pairsInFolder(folder);
        expect(pairs.map((pair) => pair.screen)).toEqual(["agents"]);

        const list = parseShotList(
            {
                title: "Hub polish",
                pairs: [{ screen: "agents", before: "01-agents-before.png", after: "/abs/after.png", fix: "H3" }],
            },
            folder
        );
        expect(list.pairs[0]).toMatchObject({
            before: join(folder, "01-agents-before.png"),
            after: "/abs/after.png",
            fix: "H3",
        });

        const result = await reportPair(
            { ...pairs[0], fix: "H3", note: "The badge moved." },
            1,
            options(join(folder, "out"))
        );
        const order = orderLines([result]);
        expect(order).toEqual([
            join(folder, "out", "01-agents-1-before.png"),
            join(folder, "out", "01-agents-2-after.png"),
        ]);

        const command = previewOpenCommand(join(folder, "out", "order.txt"));
        const markdown = renderReportMarkdown({
            title: "Hub polish",
            results: [result],
            notePath: join(folder, "out", "report.md"),
            openCommand: command,
            writtenAt: "2026-10-30 21:00",
        });
        expect(command).toContain("open -a Preview");
        expect(markdown).toContain("# Hub polish");
        expect(markdown).toContain("## 01 agents (H3)");
        expect(markdown).toContain("The badge moved.");
        expect(markdown).toContain("![before](01-agents-1-before.png)");
        expect(markdown).toContain(command);
    });
});
