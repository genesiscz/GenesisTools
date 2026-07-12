import { expect, test } from "@playwright/test";
import { boardDoc, freshBoard, seedCard, seedNote, seedTextCard } from "../helpers/boards-test-api";
import { BoardDetailPage } from "../pages/board-detail-page";

/** Regression specs for the 2026-07-12 boards polish — one describe per bug cluster. */

test.describe("optimistic moves + undo/redo", () => {
    test("drop position survives a slow server confirm (no jump-back)", async ({ page, request }) => {
        const slug = await freshBoard(request, "slowpatch");
        const note = await seedNote(request, slug, "slow server", { x: 100, y: 100 });

        const board = new BoardDetailPage(page);
        await board.goto(slug);

        // Artificial 800ms latency on the PATCH — the old code flashed back to x=100
        // while waiting for the refetch.
        await page.route(`**/api/boards/cards/${note.id}`, async (route) => {
            await new Promise((resolve) => setTimeout(resolve, 800));
            await route.fallback();
        });

        await board.dragCardBy(note.id, 180, 0);

        // Wait for the drop position to render once, then it must NEVER regress while the
        // 800ms PATCH is still in flight.
        const left = () => board.card(note.id).evaluate((el) => Number.parseFloat((el as HTMLElement).style.left));
        await expect.poll(left).toBeGreaterThan(200);

        for (let i = 0; i < 6; i++) {
            expect(await left(), "card must hold its drop position while the PATCH is in flight").toBeGreaterThan(200);
            await page.waitForTimeout(120);
        }

        await expect.poll(async () => (await boardDoc(request, slug)).cards.find((c) => c.id === note.id)?.x).toBe(280);
    });

    test("cmd+z / cmd+shift+z round-trip a move", async ({ page, request }) => {
        const slug = await freshBoard(request, "undo");
        const note = await seedNote(request, slug, "undo me", { x: 100, y: 100 });

        const board = new BoardDetailPage(page);
        await board.goto(slug);
        await board.dragCardBy(note.id, 150, 50);

        await expect.poll(async () => (await boardDoc(request, slug)).cards.find((c) => c.id === note.id)?.x).toBe(250);

        await board.pressUndo();
        await expect.poll(async () => (await boardDoc(request, slug)).cards.find((c) => c.id === note.id)?.x).toBe(100);

        await board.pressRedo();
        await expect.poll(async () => (await boardDoc(request, slug)).cards.find((c) => c.id === note.id)?.x).toBe(250);
    });

    test("backspace-deleted card is restored by undo with the SAME id", async ({ page, request }) => {
        const slug = await freshBoard(request, "restore");
        const note = await seedNote(request, slug, "delete + undo", { x: 200, y: 200 });

        const board = new BoardDetailPage(page);
        await board.goto(slug);
        await board.clickCard(note.id);
        await page.keyboard.press("Backspace");

        await expect.poll(async () => (await boardDoc(request, slug)).cards.some((c) => c.id === note.id)).toBe(false);

        await board.pressUndo();
        await expect.poll(async () => (await boardDoc(request, slug)).cards.some((c) => c.id === note.id)).toBe(true);
    });
});

test.describe("sections", () => {
    test("section tool creates, inline-renames; frame drags and resizes; backspace deletes", async ({
        page,
        request,
    }) => {
        const slug = await freshBoard(request, "sections");
        const board = new BoardDetailPage(page);
        await board.goto(slug);

        await board.selectTool("section");
        await board.dragOnCanvas({ x: 300, y: 200 }, { x: 560, y: 420 });

        // Creation POSTs first; the inline rename input mounts when the card lands.
        const renameInput = page.locator('[data-card-kind="section"] input');
        await renameInput.waitFor();
        await renameInput.fill("Journey A");
        await page.keyboard.press("Enter");

        await expect
            .poll(async () =>
                (await boardDoc(request, slug)).cards.find(
                    (c) => c.kind === "section" && c.payload.title === "Journey A"
                )
            )
            .toBeTruthy();
        const doc = await boardDoc(request, slug);
        const section = doc.cards.find((c) => c.kind === "section");

        if (!section) {
            throw new Error("section missing");
        }

        // Drag the frame by its interior.
        await board.dragCardBy(section.id, 80, 40);
        await expect
            .poll(async () => (await boardDoc(request, slug)).cards.find((c) => c.id === section.id)?.x)
            .toBe(section.x + 80);

        // Resize via the SE handle (selection ring is already on after the drag).
        const handle = page.locator(`[data-section-id="${section.id}"] .dd-card-handle-se`);
        await expect(handle).toBeVisible();
        const hb = await handle.boundingBox();

        if (!hb) {
            throw new Error("handle box missing");
        }

        await page.mouse.move(hb.x + 5, hb.y + 5);
        await page.mouse.down();
        await page.mouse.move(hb.x + 65, hb.y + 45, { steps: 4 });
        await page.mouse.up();
        await expect
            .poll(async () => (await boardDoc(request, slug)).cards.find((c) => c.id === section.id)?.w)
            .toBeGreaterThan(section.w + 40);

        await page.keyboard.press("Backspace");
        await expect
            .poll(async () => (await boardDoc(request, slug)).cards.some((c) => c.id === section.id))
            .toBe(false);
    });

    test("dragging a section carries the cards inside it", async ({ page, request }) => {
        const slug = await freshBoard(request, "carry");
        const section = await seedCard(request, slug, {
            kind: "section",
            x: 100,
            y: 100,
            w: 400,
            h: 300,
            z: -12,
            payload: { title: "Carrier" },
        });
        const member = await seedNote(request, slug, "inside", { x: 150, y: 150 });

        const board = new BoardDetailPage(page);
        await board.goto(slug);
        await board.dragCardBy(section.id, 100, 60);

        await expect
            .poll(async () => {
                const doc = await boardDoc(request, slug);
                const m = doc.cards.find((c) => c.id === member.id);
                return m ? { x: m.x, y: m.y } : null;
            })
            .toEqual({ x: 250, y: 210 });
    });

    test("connect tool wires FROM a section to a card", async ({ page, request }) => {
        const slug = await freshBoard(request, "wire-section");
        const section = await seedCard(request, slug, {
            kind: "section",
            x: 100,
            y: 100,
            w: 250,
            h: 200,
            z: -12,
            payload: { title: "Source" },
        });
        const note = await seedNote(request, slug, "target", { x: 500, y: 150 });

        const board = new BoardDetailPage(page);
        await board.goto(slug);
        await board.selectTool("connect");
        await board.dragOnCanvas({ x: 200, y: 180 }, { x: 560, y: 200 });

        await expect
            .poll(async () =>
                (await boardDoc(request, slug)).edges.some((e) => e.fromCard === section.id && e.toCard === note.id)
            )
            .toBe(true);
    });
});

test.describe("text editing + markdown", () => {
    test("double-click edits a text card; markdown tables render; undo restores", async ({ page, request }) => {
        const slug = await freshBoard(request, "mdedit");
        const card = await seedTextCard(request, slug, "original", { x: 200, y: 150 });

        const board = new BoardDetailPage(page);
        await board.goto(slug);
        await board.card(card.id).dblclick({ position: { x: 8, y: 8 } });

        const editor = page.locator(`[data-card-id="${card.id}"] textarea`);
        await expect(editor).toBeVisible();
        await editor.fill("# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |");
        await page.mouse.click(80, 700); // canvas click commits via unmount

        await expect
            .poll(async () => {
                const md = (await boardDoc(request, slug)).cards.find((c) => c.id === card.id)?.payload.md;
                return typeof md === "string" && md.startsWith("# Title");
            })
            .toBe(true);
        await expect(page.locator(`[data-card-id="${card.id}"] .dd-board-md table`)).toBeVisible();

        await board.pressUndo();
        await expect
            .poll(async () => (await boardDoc(request, slug)).cards.find((c) => c.id === card.id)?.payload.md)
            .toBe("original");
    });

    test("note tool click creates an editable note; backspace+undo keeps id", async ({ page, request }) => {
        const slug = await freshBoard(request, "notetool");
        const board = new BoardDetailPage(page);
        await board.goto(slug);

        await board.selectTool("note");
        const box = await board.canvas.boundingBox();

        if (!box) {
            throw new Error("no canvas box");
        }

        await page.mouse.click(box.x + 400, box.y + 300);
        await expect.poll(async () => (await boardDoc(request, slug)).cards.length).toBe(1);
        // Note opens straight into its inline editor.
        await page.keyboard.type("captured thought");
        await page.mouse.click(box.x + 900, box.y + 600);

        await expect.poll(async () => (await boardDoc(request, slug)).cards[0]?.payload.text).toBe("captured thought");
    });
});

test.describe("tools: annotate anywhere, table, ink shapes", () => {
    test("annotate offers the composer on a TEXT card (not just screenshots)", async ({ page, request }) => {
        const slug = await freshBoard(request, "anno");
        const card = await seedTextCard(request, slug, "annotate me", { x: 200, y: 150 });

        const board = new BoardDetailPage(page);
        await board.goto(slug);
        await board.selectTool("annotate");

        const el = board.card(card.id);
        const box = await el.boundingBox();

        if (!box) {
            throw new Error("no card box");
        }

        await page.mouse.move(box.x + 10, box.y + 10);
        await page.mouse.down();
        await page.mouse.move(box.x + 120, box.y + 80, { steps: 4 });
        await page.mouse.up();

        const composer = page.locator('textarea[placeholder="what should change here?"]');
        await expect(composer).toBeVisible();
        await composer.fill("make it pop");
        await page.keyboard.press("Enter");

        await expect
            .poll(async () => (await boardDoc(request, slug)).annotations.some((a) => a.cardId === card.id))
            .toBe(true);
    });

    test("table tool creates an editable table card", async ({ page, request }) => {
        const slug = await freshBoard(request, "table");
        const board = new BoardDetailPage(page);
        await board.goto(slug);

        await board.selectTool("table");
        const box = await board.canvas.boundingBox();

        if (!box) {
            throw new Error("no canvas box");
        }

        await page.mouse.click(box.x + 400, box.y + 250);

        await expect.poll(async () => (await boardDoc(request, slug)).cards.some((c) => c.kind === "viz")).toBe(true);
        await expect(page.locator(".dd-viz-table")).toBeVisible();

        // Inline-edit the first cell: real focus, real typing, real blur.
        const cell = page.locator(".dd-viz-table td").first();
        await cell.click();
        await page.keyboard.type("42");
        await page.mouse.click(box.x + 900, box.y + 600);

        await expect
            .poll(async () => {
                const viz = (await boardDoc(request, slug)).cards.find((c) => c.kind === "viz");
                const data = viz?.payload.data as { rows?: unknown[][] } | undefined;
                return data?.rows?.[0]?.[0];
            })
            .toBe("42");
    });

    test("closed ink loop becomes a shape card; scribble stays ink without blinking", async ({ page, request }) => {
        const slug = await freshBoard(request, "ink");
        const board = new BoardDetailPage(page);
        await board.goto(slug);
        await board.selectTool("ink");

        const box = await board.canvas.boundingBox();

        if (!box) {
            throw new Error("no canvas box");
        }

        // Circle → shape card.
        const cx = box.x + 400;
        const cy = box.y + 300;
        await page.mouse.move(cx + 60, cy);
        await page.mouse.down();

        for (let i = 1; i <= 24; i++) {
            const a = (i / 24) * Math.PI * 2;
            await page.mouse.move(cx + Math.cos(a) * 60, cy + Math.sin(a) * 60);
        }

        await page.mouse.up();
        await expect
            .poll(async () =>
                (await boardDoc(request, slug)).cards.some((c) => c.kind === "shape" && c.payload.shape === "ellipse")
            )
            .toBe(true);

        // Open scribble → stroke, present in the DOM continuously (temp id swaps for server id).
        await page.mouse.move(box.x + 700, box.y + 500);
        await page.mouse.down();

        for (let i = 1; i <= 10; i++) {
            await page.mouse.move(box.x + 700 + i * 14, box.y + 500 + Math.sin(i * 1.3) * 40);
        }

        await page.mouse.up();

        // Once the optimistic stroke renders it must stay rendered through the temp-id →
        // server-id swap (the old flow blinked: live stroke cleared, refetch later).
        const strokeCount = () => page.locator('svg polyline[stroke="#e33352"]').count();
        await expect.poll(strokeCount).toBeGreaterThan(0);

        for (let i = 0; i < 6; i++) {
            expect(await strokeCount(), "stroke blinked away").toBeGreaterThan(0);
            await page.waitForTimeout(100);
        }

        await expect.poll(async () => (await boardDoc(request, slug)).strokes.length).toBe(1);
    });
});

test.describe("ink manipulation + reposition", () => {
    test("stroke drags to a new position, undo restores; backspace deletes with undo", async ({ page, request }) => {
        const slug = await freshBoard(request, "strokemove");
        await request.post(`/api/boards/${slug}/strokes`, {
            data: {
                strokes: [
                    {
                        path: [
                            [300, 300],
                            [380, 340],
                            [460, 300],
                        ],
                        color: "#e33352",
                        width: 3,
                    },
                ],
            },
        });

        const board = new BoardDetailPage(page);
        await board.goto(slug);

        const box = await board.canvas.boundingBox();

        if (!box) {
            throw new Error("no canvas box");
        }

        // Drag from a point ON the path (viewport starts untransformed → world == canvas offset).
        await page.mouse.move(box.x + 380, box.y + 340);
        await page.mouse.down();
        await page.mouse.move(box.x + 430, box.y + 370, { steps: 5 });
        await page.mouse.up();

        await expect.poll(async () => (await boardDoc(request, slug)).strokes[0]?.path[0][0]).toBe(350);

        await board.pressUndo();
        await expect.poll(async () => (await boardDoc(request, slug)).strokes[0]?.path[0][0]).toBe(300);

        await page.mouse.click(box.x + 380, box.y + 340);
        await page.keyboard.press("Backspace");
        await expect.poll(async () => (await boardDoc(request, slug)).strokes.length).toBe(0);

        await board.pressUndo();
        await expect.poll(async () => (await boardDoc(request, slug)).strokes.length).toBe(1);
    });

    test("reposition keeps section members inside their frame", async ({ page, request }) => {
        const slug = await freshBoard(request, "sectkeep");
        const section = await seedCard(request, slug, {
            kind: "section",
            x: 600,
            y: 400,
            w: 400,
            h: 300,
            z: -12,
            payload: { title: "Container" },
        });
        const memberA = await seedNote(request, slug, "member A", { x: 650, y: 450 });
        const memberB = await seedNote(request, slug, "member B", { x: 700, y: 560 });
        await seedTextCard(request, slug, "loose one", { x: 100, y: 100 });
        await seedTextCard(request, slug, "loose two", { x: 120, y: 130 });

        const board = new BoardDetailPage(page);
        await board.goto(slug);
        await page.getByTestId("reposition-button").click();
        await page.waitForTimeout(1000);

        const doc = await boardDoc(request, slug);
        const frame = doc.cards.find((c) => c.id === section.id);

        if (!frame) {
            throw new Error("section vanished");
        }

        for (const id of [memberA.id, memberB.id]) {
            const m = doc.cards.find((c) => c.id === id);

            if (!m) {
                throw new Error(`member ${id} vanished`);
            }

            const cx = m.x + m.w / 2;
            const cy = m.y + m.h / 2;
            expect(cx, `member ${id} center x inside frame`).toBeGreaterThanOrEqual(frame.x);
            expect(cx, `member ${id} center x inside frame`).toBeLessThanOrEqual(frame.x + frame.w);
            expect(cy, `member ${id} center y inside frame`).toBeGreaterThanOrEqual(frame.y);
            expect(cy, `member ${id} center y inside frame`).toBeLessThanOrEqual(frame.y + frame.h);
        }

        // Relative offsets inside the frame are preserved (frame+members moved as one unit).
        expect(doc.cards.find((c) => c.id === memberA.id)!.x - frame.x).toBe(memberA.x - section.x);
        expect(doc.cards.find((c) => c.id === memberB.id)!.y - frame.y).toBe(memberB.y - section.y);
    });

    test("reposition removes card overlaps", async ({ page, request }) => {
        const slug = await freshBoard(request, "repack");
        // Three deliberately overlapping text cards.
        await seedTextCard(request, slug, "one", { x: 100, y: 100 });
        await seedTextCard(request, slug, "two", { x: 150, y: 130 });
        await seedTextCard(request, slug, "three", { x: 200, y: 160 });

        const overlaps = async () => {
            const { cards } = await boardDoc(request, slug);
            let n = 0;

            for (let i = 0; i < cards.length; i++) {
                for (let j = i + 1; j < cards.length; j++) {
                    const a = cards[i];
                    const b = cards[j];

                    if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) {
                        n++;
                    }
                }
            }

            return n;
        };

        expect(await overlaps()).toBeGreaterThan(0);

        const board = new BoardDetailPage(page);
        await board.goto(slug);
        await page.getByTestId("reposition-button").click();

        await expect.poll(overlaps, { timeout: 10_000 }).toBe(0);
    });
});

test.describe("staged pill + picker re-answer", () => {
    test("staged annotation pill never covers the toolbar", async ({ page, request }) => {
        const slug = await freshBoard(request, "pill");
        const card = await seedTextCard(request, slug, "pill test", { x: 200, y: 150 });
        await request.post("/api/boards/annotations", {
            data: {
                board: slug,
                cardId: card.id,
                region: { x: 0, y: 0, w: 50, h: 30 },
                intent: "fix",
                prompt: "staged item",
                createdBy: "playwright",
            },
        });

        const board = new BoardDetailPage(page);
        await board.goto(slug);
        await expect(board.stagedPill).toBeVisible();

        const pill = await board.stagedPill.boundingBox();
        const toolbar = await board.toolbar.boundingBox();

        if (!pill || !toolbar) {
            throw new Error("missing boxes");
        }

        const overlap =
            pill.x < toolbar.x + toolbar.width &&
            pill.x + pill.width > toolbar.x &&
            pill.y < toolbar.y + toolbar.height &&
            pill.y + pill.height > toolbar.y;
        expect(overlap, "staged pill must not cover the toolbar").toBe(false);

        // Every tool stays clickable while the pill is up.
        await board.selectTool("ink");
        await expect(board.toolButton("ink")).toHaveAttribute("aria-pressed", "true");
    });

    test("picker answers stay re-pickable while staged", async ({ page, request }) => {
        const slug = await freshBoard(request, "picker");
        const created = await request.post(`/api/boards/${slug}/questions`, {
            data: { prompt: "Pick one", options: ["Alpha", "Beta"] },
        });
        expect(created.ok()).toBeTruthy();

        const board = new BoardDetailPage(page);
        await board.goto(slug);

        await page.getByRole("button", { name: "Alpha", exact: true }).click();
        await expect
            .poll(async () => (await request.get(`/api/boards/${slug}/questions`)).json())
            .toMatchObject({ questions: [{ answer: ["Alpha"], staged: true }] });

        // Toolbar remains reachable with the staged pill up, and the answer can change.
        await expect(board.stagedPill).toBeVisible();
        await board.selectTool("move");
        await page.getByRole("button", { name: "Beta", exact: true }).click();
        await expect
            .poll(async () => (await request.get(`/api/boards/${slug}/questions`)).json())
            .toMatchObject({ questions: [{ answer: ["Beta"], staged: true }] });
    });
});
