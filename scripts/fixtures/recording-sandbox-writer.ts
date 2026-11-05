/**
 * Makes an invented screen recording folder, so the recording editor can be opened and screenshotted without any real
 * screen content: a 50 s movie of a made-up "Northwind Console" dashboard, its cursor track (clicks, shortcuts), a
 * transcript, two recorded markers and an edit with a zoom, a hidden part and a text.
 *
 *     bun scripts/fixtures/recording-sandbox.ts --out <dir>
 *
 * This ffmpeg build has no `drawtext` (no freetype), and a `drawbox` graph with thousands of boxes crashes it
 * (exit 138), so the script draws each frame itself from filled boxes (a 5x7 pixel font for every letter and digit)
 * and pipes the raw frames into ffmpeg, which encodes the movie and a soft two-tone sound. Nothing is read from the screen and nothing is written
 * outside `--out`: the script runs its own process with `GENESIS_TOOLS_HOME` pointed at a temporary home, so the
 * logger and every other `~/.genesis-tools` path stay off the real one.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { computeEdit, openProject } from "@app/recorder/lib/edit";
import { runTool } from "@genesiscz/utils/cli";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import {
    type EditOp,
    type EditProject,
    transcriptCachePath,
    writeProject,
} from "@genesiscz/utils/recording-editor/project";
import {
    RECORDING_MANIFEST,
    type RecordingManifest,
    recordingManifestSchema,
} from "@genesiscz/utils/screen-recorder/library";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { probeVideo } from "@genesiscz/utils/video/probe";
import { Command } from "commander";

const { log } = logger.scoped("recording-sandbox");

const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;
const DURATION_S = 50;

const PALETTE = {
    background: "0x0d1117",
    bar: "0x161b22",
    side: "0x11161d",
    card: "0x161b22",
    border: "0x30363d",
    text: "0xe6edf3",
    muted: "0x8b949e",
    blue: "0x2f81f7",
    blueLight: "0x58a6ff",
    green: "0x3fb950",
    red: "0xf85149",
    amber: "0xd29922",
    modal: "0x1c2128",
} as const;

/** The 5x7 pixel font: seven rows, `#` is a lit pixel. Every text of the movie is upper case. */
const GLYPH_SOURCE: Record<string, string> = {
    A: ".###. #...# #...# ##### #...# #...# #...#",
    B: "####. #...# #...# ####. #...# #...# ####.",
    C: ".###. #...# #.... #.... #.... #...# .###.",
    D: "####. #...# #...# #...# #...# #...# ####.",
    E: "##### #.... #.... ####. #.... #.... #####",
    F: "##### #.... #.... ####. #.... #.... #....",
    G: ".###. #...# #.... #.### #...# #...# .###.",
    H: "#...# #...# #...# ##### #...# #...# #...#",
    I: "##### ..#.. ..#.. ..#.. ..#.. ..#.. #####",
    J: "..### ...#. ...#. ...#. ...#. #..#. .##..",
    K: "#...# #..#. #.#.. ##... #.#.. #..#. #...#",
    L: "#.... #.... #.... #.... #.... #.... #####",
    M: "#...# ##.## #.#.# #.#.# #...# #...# #...#",
    N: "#...# ##..# #.#.# #..## #...# #...# #...#",
    O: ".###. #...# #...# #...# #...# #...# .###.",
    P: "####. #...# #...# ####. #.... #.... #....",
    Q: ".###. #...# #...# #...# #.#.# #..#. .##.#",
    R: "####. #...# #...# ####. #.#.. #..#. #...#",
    S: ".#### #.... #.... .###. ....# ....# ####.",
    T: "##### ..#.. ..#.. ..#.. ..#.. ..#.. ..#..",
    U: "#...# #...# #...# #...# #...# #...# .###.",
    V: "#...# #...# #...# #...# #...# .#.#. ..#..",
    W: "#...# #...# #...# #.#.# #.#.# ##.## #...#",
    X: "#...# #...# .#.#. ..#.. .#.#. #...# #...#",
    Y: "#...# #...# .#.#. ..#.. ..#.. ..#.. ..#..",
    Z: "##### ....# ...#. ..#.. .#... #.... #####",
    "0": ".###. #...# #..## #.#.# ##..# #...# .###.",
    "1": "..#.. .##.. ..#.. ..#.. ..#.. ..#.. .###.",
    "2": ".###. #...# ....# ...#. ..#.. .#... #####",
    "3": "####. ....# ....# .###. ....# ....# ####.",
    "4": "...#. ..##. .#.#. #..#. ##### ...#. ...#.",
    "5": "##### #.... ####. ....# ....# #...# .###.",
    "6": "..##. .#... #.... ####. #...# #...# .###.",
    "7": "##### ....# ...#. ..#.. .#... .#... .#...",
    "8": ".###. #...# #...# .###. #...# #...# .###.",
    "9": ".###. #...# #...# .#### ....# ...#. .##..",
    ".": "..... ..... ..... ..... ..... .##.. .##..",
    ",": "..... ..... ..... ..... .##.. ..#.. .#...",
    ":": "..... .##.. .##.. ..... .##.. .##.. .....",
    "%": "##..# ##..# ...#. ..#.. .#... #..## #..##",
    $: "..#.. .#### #.#.. .###. ..#.# ####. ..#..",
    "-": "..... ..... ..... ##### ..... ..... .....",
    "+": "..... ..#.. ..#.. ##### ..#.. ..#.. .....",
    "/": "....# ....# ...#. ..#.. .#... #.... #....",
    "@": ".###. #...# #.### #.#.# #.### #.... .###.",
    "(": "...#. ..#.. .#... .#... .#... ..#.. ...#.",
    ")": ".#... ..#.. ...#. ...#. ...#. ..#.. .#...",
    "!": "..#.. ..#.. ..#.. ..#.. ..#.. ..... ..#..",
    "'": "..#.. ..#.. .#... ..... ..... ..... .....",
    " ": "..... ..... ..... ..... ..... ..... .....",
};

const GLYPHS: Record<string, string[]> = Object.fromEntries(
    Object.entries(GLYPH_SOURCE).map(([char, rows]) => [char, rows.split(" ")])
);

const GLYPH_ROWS = 7;
const GLYPH_COLUMNS = 5;

/** Whether a box shows at second `t` of the movie. */
type Enable = (t: number) => boolean;

/** One filled box, or an outline when `border` is set. `enable` absent shows it on every frame. */
interface Box {
    x: number;
    y: number;
    w: number;
    h: number;
    color: string;
    /** A border of this many pixels; absent fills the box. */
    border?: number;
    enable?: Enable;
}

function textWidth(text: string, scale: number): number {
    return text.length * (GLYPH_COLUMNS + 1) * scale - scale;
}

/** The boxes that draw `text`: each row of the string is merged into horizontal runs, so a long label stays small. */
function textBoxes({
    text,
    x,
    y,
    scale,
    color,
    enable,
}: {
    text: string;
    x: number;
    y: number;
    scale: number;
    color: string;
    enable?: Enable;
}): Box[] {
    const boxes: Box[] = [];
    const columns = text.length * (GLYPH_COLUMNS + 1);

    for (let row = 0; row < GLYPH_ROWS; row++) {
        const lit: boolean[] = new Array(columns).fill(false);

        for (const [index, char] of [...text.toUpperCase()].entries()) {
            const glyph = GLYPHS[char];

            if (!glyph) {
                throw new Error(`the pixel font has no glyph for "${char}"`);
            }

            for (let column = 0; column < GLYPH_COLUMNS; column++) {
                lit[index * (GLYPH_COLUMNS + 1) + column] = glyph[row][column] === "#";
            }
        }

        let start = -1;

        for (let column = 0; column <= columns; column++) {
            if (column < columns && lit[column]) {
                if (start < 0) {
                    start = column;
                }

                continue;
            }

            if (start >= 0) {
                boxes.push({
                    x: x + start * scale,
                    y: y + row * scale,
                    w: (column - start) * scale,
                    h: scale,
                    color,
                    enable,
                });
                start = -1;
            }
        }
    }

    return boxes;
}

const BETWEEN =
    (from: number, to: number): Enable =>
    (t) =>
        t >= from && t <= to;

/** A counter that changes while the movie plays: `base + rate * t`, one digit glyph per place, each shown by its digit. */
interface Counter {
    x: number;
    y: number;
    scale: number;
    base: number;
    rate: number;
    /** Left to right: a digit place (its power of ten) or a fixed character. */
    layout: ReadonlyArray<{ pow: number } | { literal: string }>;
}

function counterBoxes(counter: Counter): { fixed: Box[]; moving: Box[] } {
    const fixed: Box[] = [];
    const moving: Box[] = [];
    const advance = (GLYPH_COLUMNS + 1) * counter.scale;

    for (const [index, place] of counter.layout.entries()) {
        const x = counter.x + index * advance;

        if ("literal" in place) {
            fixed.push(
                ...textBoxes({ text: place.literal, x, y: counter.y, scale: counter.scale, color: PALETTE.text })
            );
            continue;
        }

        for (let digit = 0; digit < 10; digit++) {
            const { base, rate } = counter;
            const enable: Enable = (t) => Math.floor((base + rate * t) / place.pow) % 10 === digit;
            moving.push(
                ...textBoxes({
                    text: String(digit),
                    x,
                    y: counter.y,
                    scale: counter.scale,
                    color: PALETTE.text,
                    enable,
                })
            );
        }
    }

    return { fixed, moving };
}

/** Where things sit in the 1920 x 1080 picture. */
const LAYOUT = {
    sidebarWidth: 260,
    barHeight: 72,
    nav: ["OVERVIEW", "ORDERS", "CUSTOMERS", "PAYMENTS", "REPORTS", "SETTINGS"],
    navTop: 124,
    navStep: 64,
    cards: { y: 170, h: 180, w: 370, xs: [300, 702, 1104, 1506] },
    chart: { x: 300, y: 390, w: 940, h: 370 },
    accounts: { x: 1280, y: 390, w: 596, h: 370 },
    table: { x: 300, y: 780, w: 1576, h: 270 },
    exportButton: { x: 1640, y: 108, w: 236, h: 48 },
    search: { x: 560, y: 220, w: 800, h: 340 },
} as const;

const ACCOUNTS = [
    ["KESTREL FOODS", "$61,900"],
    ["LUMEN LABS", "$55,300"],
    ["HARBOR RETAIL", "$48,200"],
    ["PINECREST TOYS", "$39,750"],
    ["QUILL CYCLES", "$31,400"],
] as const;

const ORDERS = [
    ["10482", "HARBOR RETAIL", "BUYER@HARBOR.EXAMPLE", "PAID", "$2,140"],
    ["10481", "KESTREL FOODS", "AP@KESTREL.EXAMPLE", "PAID", "$5,880"],
    ["10480", "LUMEN LABS", "ORDERS@LUMEN.EXAMPLE", "PENDING", "$960"],
    ["10479", "PINECREST TOYS", "SHOP@PINECREST.EXAMPLE", "FAILED", "$1,275"],
] as const;

const TABLE_COLUMNS = { order: 330, customer: 480, email: 860, status: 1290, total: 1620 } as const;
const TABLE_FIRST_ROW = 852;
const TABLE_ROW_STEP = 48;

const ACCOUNT_FIRST_ROW = 470;
const ACCOUNT_ROW_STEP = 56;

const STATUS_COLORS: Record<string, string> = { PAID: PALETTE.green, PENDING: PALETTE.amber, FAILED: PALETTE.red };

interface Click {
    t: number;
    x: number;
    y: number;
    /** What lights up for a moment: the clicked panel's outline. */
    flash?: { x: number; y: number; w: number; h: number };
}

const CLICKS: Click[] = [
    { t: 5.5, x: 130, y: LAYOUT.navTop + LAYOUT.navStep + 24 },
    { t: 10.8, x: 485, y: 262, flash: { x: 300, y: 170, w: 370, h: 180 } },
    { t: 16.5, x: 1130, y: 560, flash: { x: 300, y: 390, w: 940, h: 370 } },
    { t: 26.0, x: 760, y: 392 },
    { t: 38.0, x: 1291, y: 262, flash: { x: 1104, y: 170, w: 370, h: 180 } },
    { t: 44.5, x: 1758, y: 132 },
];

const SHORTCUTS = [
    { t: 20.0, key: "⌘K" },
    { t: 33.0, key: "⌘⇧R" },
    { t: 44.2, key: "⌘E" },
];

/** The cursor's route: where it rests between clicks. The track moves it smoothly from stop to stop. */
const WAYPOINTS: Array<{ t: number; x: number; y: number }> = [
    { t: 0, x: 980, y: 560 },
    { t: 3.2, x: 640, y: 440 },
    ...CLICKS.slice(0, 1).map((click) => ({ t: click.t, x: click.x, y: click.y })),
    { t: 8.4, x: 560, y: 300 },
    ...CLICKS.slice(1, 2).map((click) => ({ t: click.t, x: click.x, y: click.y })),
    { t: 14.0, x: 820, y: 520 },
    ...CLICKS.slice(2, 3).map((click) => ({ t: click.t, x: click.x, y: click.y })),
    { t: 19.0, x: 1500, y: 300 },
    { t: 21.0, x: 960, y: 300 },
    { t: 24.0, x: 900, y: 420 },
    ...CLICKS.slice(3, 4).map((click) => ({ t: click.t, x: click.x, y: click.y })),
    { t: 29.0, x: 1000, y: 830 },
    { t: 30.4, x: 1000, y: 868 },
    { t: 32.0, x: 1000, y: 918 },
    { t: 34.0, x: 1000, y: 968 },
    { t: 36.0, x: 1000, y: 1018 },
    ...CLICKS.slice(4, 5).map((click) => ({ t: click.t, x: click.x, y: click.y })),
    { t: 41.0, x: 1500, y: 300 },
    { t: 43.4, x: 1700, y: 200 },
    ...CLICKS.slice(5, 6).map((click) => ({ t: click.t, x: click.x, y: click.y })),
    { t: 47.0, x: 1500, y: 600 },
    { t: DURATION_S, x: 1480, y: 640 },
];

interface Line {
    speaker: "Alice Novak" | "Ben Carter";
    start: number;
    end: number;
    text: string;
}

const TRANSCRIPT: Line[] = [
    {
        speaker: "Alice Novak",
        start: 0.8,
        end: 5.2,
        text: "Hi everyone, this is the Northwind Console, and I will walk through today's orders.",
    },
    {
        speaker: "Ben Carter",
        start: 6.2,
        end: 10.2,
        text: "Alice, finance always asks about revenue first, so can you open that card?",
    },
    {
        speaker: "Alice Novak",
        start: 11.2,
        end: 16.0,
        text: "Sure. Revenue is up this week, and the chart shows a jump after Tuesday's release.",
    },
    {
        speaker: "Ben Carter",
        start: 17.6,
        end: 23.6,
        text: "Nice. Can you search for the Harbor Retail account with the quick search?",
    },
    {
        speaker: "Alice Novak",
        start: 24.0,
        end: 29.0,
        text: "Yes, command K opens it, and Harbor Retail is the third account in the list.",
    },
    {
        speaker: "Ben Carter",
        start: 30.2,
        end: 37.0,
        text: "Okay. And the failed payments? That number looked high on Monday.",
    },
    {
        speaker: "Alice Novak",
        start: 37.6,
        end: 43.0,
        text: "It dropped from forty to twelve after the retry fix, so I will mark this for the review.",
    },
    {
        speaker: "Alice Novak",
        start: 44.0,
        end: 49.0,
        text: "That is all from me. I will send the export to the team today.",
    },
];

const MARKERS = [
    { atMs: 10_800, label: "Revenue card" },
    { atMs: 38_000, label: "Failed payments" },
];

const KPI_CARDS = [
    {
        label: "REVENUE",
        delta: "+8.2% VS LAST WEEK",
        deltaColor: PALETTE.green,
        counter: {
            base: 128_450,
            rate: 37,
            layout: [
                { literal: "$" },
                { pow: 100_000 },
                { pow: 10_000 },
                { pow: 1_000 },
                { literal: "," },
                { pow: 100 },
                { pow: 10 },
                { pow: 1 },
            ],
        },
    },
    {
        label: "ORDERS",
        delta: "+3.1% VS LAST WEEK",
        deltaColor: PALETTE.green,
        counter: {
            base: 1_284,
            rate: 0.4,
            layout: [{ pow: 1_000 }, { literal: "," }, { pow: 100 }, { pow: 10 }, { pow: 1 }],
        },
    },
    {
        label: "FAILED PAYMENTS",
        delta: "RETRY FIX SHIPPED",
        deltaColor: PALETTE.green,
        counter: { base: 40, rate: -0.56, layout: [{ pow: 10 }, { pow: 1 }] },
    },
    {
        label: "CONVERSION",
        delta: "-0.2% VS LAST WEEK",
        deltaColor: PALETTE.red,
        counter: {
            base: 342,
            rate: 0.5,
            layout: [{ pow: 100 }, { literal: "." }, { pow: 10 }, { pow: 1 }, { literal: "%" }],
        },
    },
] as const;

const DAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
/** Bar heights in pixels, three sets of the chart that swap while the movie plays (the last bar is today). */
const CHART_STEPS = [
    { from: 0, to: 15, heights: [150, 170, 230, 190, 210, 120, 90] },
    { from: 15, to: 30, heights: [150, 170, 230, 190, 210, 120, 160] },
    { from: 30, to: DURATION_S, heights: [150, 170, 230, 190, 210, 120, 240] },
];

function staticBoxes(): Box[] {
    const boxes: Box[] = [];
    const fill = (x: number, y: number, w: number, h: number, color: string) => boxes.push({ x, y, w, h, color });
    const outline = (x: number, y: number, w: number, h: number, color: string, border = 2) =>
        boxes.push({ x, y, w, h, color, border });
    const write = (text: string, x: number, y: number, scale: number, color: string) =>
        boxes.push(...textBoxes({ text, x, y, scale, color }));

    fill(0, 0, WIDTH, LAYOUT.barHeight, PALETTE.bar);
    fill(0, LAYOUT.barHeight - 2, WIDTH, 2, PALETTE.border);
    fill(28, 18, 36, 36, PALETTE.blue);
    fill(40, 30, 12, 12, PALETTE.background);
    write("NORTHWIND CONSOLE", 84, 22, 4, PALETTE.text);
    outline(1220, 16, 400, 40, PALETTE.border);
    write("SEARCH ACCOUNTS", 1240, 28, 2, PALETTE.muted);
    write("CMD K", 1530, 28, 2, PALETTE.muted);
    fill(1836, 16, 40, 40, PALETTE.green);
    write("AN", 1846, 29, 2, PALETTE.background);

    fill(0, LAYOUT.barHeight, LAYOUT.sidebarWidth, HEIGHT - LAYOUT.barHeight, PALETTE.side);
    fill(LAYOUT.sidebarWidth - 2, LAYOUT.barHeight, 2, HEIGHT - LAYOUT.barHeight, PALETTE.border);

    for (const [index, name] of LAYOUT.nav.entries()) {
        write(name, 40, LAYOUT.navTop + index * LAYOUT.navStep + 14, 3, PALETTE.muted);
    }

    write("ORDERS OVERVIEW", 300, 100, 4, PALETTE.text);
    write("LAST 7 DAYS", 300, 144, 2, PALETTE.muted);
    fill(LAYOUT.exportButton.x, LAYOUT.exportButton.y, LAYOUT.exportButton.w, LAYOUT.exportButton.h, PALETTE.blue);
    write("EXPORT", LAYOUT.exportButton.x + 58, LAYOUT.exportButton.y + 13, 3, PALETTE.text);

    for (const [index, card] of KPI_CARDS.entries()) {
        const x = LAYOUT.cards.xs[index];
        fill(x, LAYOUT.cards.y, LAYOUT.cards.w, LAYOUT.cards.h, PALETTE.card);
        outline(x, LAYOUT.cards.y, LAYOUT.cards.w, LAYOUT.cards.h, PALETTE.border);
        write(card.label, x + 24, LAYOUT.cards.y + 24, 2, PALETTE.muted);
        write(card.delta, x + 24, LAYOUT.cards.y + 142, 2, card.deltaColor);
        boxes.push(...counterBoxes({ ...card.counter, x: x + 24, y: LAYOUT.cards.y + 66, scale: 7 }).fixed);
    }

    const chart = LAYOUT.chart;
    fill(chart.x, chart.y, chart.w, chart.h, PALETTE.card);
    outline(chart.x, chart.y, chart.w, chart.h, PALETTE.border);
    write("REVENUE PER DAY", chart.x + 24, chart.y + 22, 3, PALETTE.text);

    for (let line = 0; line < 4; line++) {
        fill(chart.x + 24, chart.y + 100 + line * 62, chart.w - 48, 1, PALETTE.border);
    }

    for (const [index, day] of DAYS.entries()) {
        write(day, chart.x + 60 + index * 125, chart.y + chart.h - 40, 2, PALETTE.muted);
    }

    const accounts = LAYOUT.accounts;
    fill(accounts.x, accounts.y, accounts.w, accounts.h, PALETTE.card);
    outline(accounts.x, accounts.y, accounts.w, accounts.h, PALETTE.border);
    write("TOP ACCOUNTS", accounts.x + 24, accounts.y + 22, 3, PALETTE.text);

    for (const [index, [name, total]] of ACCOUNTS.entries()) {
        const y = ACCOUNT_FIRST_ROW + index * ACCOUNT_ROW_STEP;
        write(name, accounts.x + 28, y + 12, 3, PALETTE.text);
        write(total, accounts.x + accounts.w - 28 - textWidth(total, 3), y + 12, 3, PALETTE.muted);
    }

    const table = LAYOUT.table;
    fill(table.x, table.y, table.w, table.h, PALETTE.card);
    outline(table.x, table.y, table.w, table.h, PALETTE.border);
    write("RECENT ORDERS", table.x + 24, table.y + 16, 3, PALETTE.text);

    for (const [name, x] of [
        ["ORDER", TABLE_COLUMNS.order],
        ["CUSTOMER", TABLE_COLUMNS.customer],
        ["EMAIL", TABLE_COLUMNS.email],
        ["STATUS", TABLE_COLUMNS.status],
        ["TOTAL", TABLE_COLUMNS.total],
    ] as const) {
        write(name, x, table.y + 46, 2, PALETTE.muted);
    }

    for (const [index, row] of ORDERS.entries()) {
        const y = TABLE_FIRST_ROW + index * TABLE_ROW_STEP;
        write(row[0], TABLE_COLUMNS.order, y + 10, 3, PALETTE.text);
        write(row[1], TABLE_COLUMNS.customer, y + 10, 3, PALETTE.text);
        write(row[2], TABLE_COLUMNS.email, y + 10, 3, PALETTE.muted);
        write(row[3], TABLE_COLUMNS.status, y + 10, 3, STATUS_COLORS[row[3]] ?? PALETTE.text);
        write(row[4], TABLE_COLUMNS.total, y + 10, 3, PALETTE.text);
    }

    return boxes;
}

function movingBoxes(): Box[] {
    const boxes: Box[] = [];

    for (const [index, card] of KPI_CARDS.entries()) {
        const x = LAYOUT.cards.xs[index];
        boxes.push(...counterBoxes({ ...card.counter, x: x + 24, y: LAYOUT.cards.y + 66, scale: 7 }).moving);
    }

    const chart = LAYOUT.chart;

    for (const step of CHART_STEPS) {
        for (const [index, height] of step.heights.entries()) {
            boxes.push({
                x: chart.x + 56 + index * 125,
                y: chart.y + chart.h - 60 - height,
                w: 70,
                h: height,
                color: index === 6 ? PALETTE.green : PALETTE.blue,
                enable: BETWEEN(step.from, step.to),
            });
        }
    }

    const navY = (index: number) => LAYOUT.navTop + index * LAYOUT.navStep;
    boxes.push({
        x: 12,
        y: navY(0),
        w: LAYOUT.sidebarWidth - 28,
        h: 48,
        color: PALETTE.blueLight,
        border: 2,
        enable: BETWEEN(0, CLICKS[0].t),
    });
    boxes.push({
        x: 12,
        y: navY(1),
        w: LAYOUT.sidebarWidth - 28,
        h: 48,
        color: PALETTE.blueLight,
        border: 2,
        enable: BETWEEN(CLICKS[0].t, DURATION_S),
    });

    for (const click of CLICKS) {
        if (click.flash) {
            boxes.push({
                ...click.flash,
                color: PALETTE.blueLight,
                border: 3,
                enable: BETWEEN(click.t, click.t + 1.4),
            });
        }
    }

    const search = LAYOUT.search;
    const open = CLICKS[3].t + 0.8;
    const modalOpen = BETWEEN(SHORTCUTS[0].t, open);
    boxes.push({ x: search.x, y: search.y, w: search.w, h: search.h, color: PALETTE.modal, enable: modalOpen });
    boxes.push({
        x: search.x,
        y: search.y,
        w: search.w,
        h: search.h,
        color: PALETTE.blueLight,
        border: 2,
        enable: modalOpen,
    });
    boxes.push({
        x: search.x + 24,
        y: search.y + 24,
        w: search.w - 48,
        h: 56,
        color: PALETTE.background,
        enable: modalOpen,
    });
    boxes.push(
        ...textBoxes({
            text: "SEARCH ACCOUNTS",
            x: search.x + 44,
            y: search.y + 40,
            scale: 3,
            color: PALETTE.muted,
            enable: BETWEEN(SHORTCUTS[0].t, SHORTCUTS[0].t + 1),
        })
    );

    for (const [index, letter] of [..."HARBOR"].entries()) {
        const from = SHORTCUTS[0].t + 1 + index * 0.25;
        boxes.push(
            ...textBoxes({
                text: letter,
                x: search.x + 44 + index * 30,
                y: search.y + 38,
                scale: 5,
                color: PALETTE.text,
                enable: BETWEEN(from, open),
            })
        );
    }

    const results = [
        ["HARBOR RETAIL", "$48,200"],
        ["HARBORVIEW DENTAL", "$7,900"],
    ] as const;

    for (const [index, [name, total]] of results.entries()) {
        const y = search.y + 112 + index * 64;
        const shown = BETWEEN(SHORTCUTS[0].t + 2.6, open);
        boxes.push(
            ...textBoxes({ text: name, x: search.x + 44, y: y + 14, scale: 3, color: PALETTE.text, enable: shown })
        );
        boxes.push(
            ...textBoxes({
                text: total,
                x: search.x + search.w - 44 - textWidth(total, 3),
                y: y + 14,
                scale: 3,
                color: PALETTE.muted,
                enable: shown,
            })
        );

        if (index === 0) {
            boxes.push({ x: search.x + 24, y, w: search.w - 48, h: 50, color: PALETTE.blue, border: 2, enable: shown });
        }
    }

    const harborRow = ACCOUNT_FIRST_ROW + 2 * ACCOUNT_ROW_STEP;
    boxes.push({
        x: LAYOUT.accounts.x + 12,
        y: harborRow,
        w: LAYOUT.accounts.w - 24,
        h: 48,
        color: PALETTE.blueLight,
        border: 2,
        enable: BETWEEN(open, DURATION_S),
    });

    for (let row = 0; row < ORDERS.length; row++) {
        const from = 30 + row * 1.6;
        const to = row === ORDERS.length - 1 ? 38 : from + 1.6;
        boxes.push({
            x: LAYOUT.table.x + 12,
            y: TABLE_FIRST_ROW + row * TABLE_ROW_STEP,
            w: LAYOUT.table.w - 24,
            h: 42,
            color: PALETTE.blueLight,
            border: 2,
            enable: BETWEEN(from, to),
        });
    }

    const exported = CLICKS[5].t + 0.4;
    boxes.push({ x: 1500, y: 960, w: 376, h: 72, color: PALETTE.green, enable: BETWEEN(exported, exported + 4.5) });
    boxes.push(
        ...textBoxes({
            text: "EXPORT SAVED",
            x: 1530,
            y: 982,
            scale: 4,
            color: PALETTE.background,
            enable: BETWEEN(exported, exported + 4.5),
        })
    );

    return boxes;
}

function rgbOf(color: string): [number, number, number] {
    const value = Number(color);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** An RGB picture the boxes are drawn on. */
class Canvas {
    readonly data: Uint8Array;

    constructor(
        readonly width: number,
        readonly height: number,
        readonly channels: 3 | 4
    ) {
        this.data = new Uint8Array(width * height * channels);
    }

    fill(x: number, y: number, w: number, h: number, color: string, alpha = 255): void {
        const [red, green, blue] = rgbOf(color);
        const left = Math.max(0, x);
        const right = Math.min(this.width, x + w);
        const pixel = this.channels === 4 ? [red, green, blue, alpha] : [red, green, blue];

        for (let row = Math.max(0, y); row < Math.min(this.height, y + h); row++) {
            let at = (row * this.width + left) * this.channels;

            for (let column = left; column < right; column++) {
                for (const value of pixel) {
                    this.data[at++] = value;
                }
            }
        }
    }

    draw(box: Box): void {
        if (box.border === undefined) {
            this.fill(box.x, box.y, box.w, box.h, box.color);
            return;
        }

        const { x, y, w, h, color, border } = box;
        this.fill(x, y, w, border, color);
        this.fill(x, y + h - border, w, border, color);
        this.fill(x, y, border, h, color);
        this.fill(x + w - border, y, border, h, color);
    }
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function ffmpegFinished(proc: ReturnType<typeof Bun.spawn>, stdout: Promise<Uint8Array>, label: string) {
    const stderr = new Response(proc.stderr as ReadableStream<Uint8Array>).text();
    const [code, text, bytes] = await Promise.all([proc.exited, stderr, stdout]);

    if (code !== 0) {
        throw new Error(`ffmpeg failed (${label}, exit ${code}): ${text.trim().split("\n").slice(-6).join("\n")}`);
    }

    return bytes;
}

/** Encodes raw RGB frames from `frame(index)` as H.264 with a soft two-tone sound (220 Hz and 330 Hz, fading in and out). */
async function renderMovie(options: { movie: string }): Promise<void> {
    const base = new Canvas(WIDTH, HEIGHT, 3);
    base.fill(0, 0, WIDTH, HEIGHT, PALETTE.background);

    for (const box of staticBoxes()) {
        base.draw(box);
    }

    const moving = movingBoxes();
    const proc = Bun.spawn(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-s",
            `${WIDTH}x${HEIGHT}`,
            "-framerate",
            String(FPS),
            "-i",
            "pipe:0",
            "-f",
            "lavfi",
            "-i",
            `sine=frequency=220:sample_rate=48000:duration=${DURATION_S}`,
            "-f",
            "lavfi",
            "-i",
            `sine=frequency=330:sample_rate=48000:duration=${DURATION_S}`,
            "-filter_complex",
            `[1:a][2:a]amix=inputs=2:normalize=0,volume=0.06,afade=t=in:d=2,afade=t=out:st=${DURATION_S - 3}:d=3[a]`,
            "-map",
            "0:v",
            "-map",
            "[a]",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "20",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "96k",
            "-movflags",
            "+faststart",
            options.movie,
        ],
        { stdin: "pipe", stdout: "pipe", stderr: "pipe" }
    );
    const finished = ffmpegFinished(proc, readAll(proc.stdout), "movie");
    const frame = new Canvas(WIDTH, HEIGHT, 3);
    log.debug({ frames: DURATION_S * FPS, boxes: moving.length }, "frames start");

    for (let index = 0; index < DURATION_S * FPS; index++) {
        const t = index / FPS;
        frame.data.set(base.data);

        for (const box of moving) {
            if (!box.enable || box.enable(t)) {
                frame.draw(box);
            }
        }

        proc.stdin.write(frame.data);
        await proc.stdin.flush();
    }

    await proc.stdin.end();
    await finished;
}

/** The arrow the editor draws as the cursor: a black outline and a white fill, at 3 px per pixel (2x of 18 x 28.5 pt). */
const CURSOR_ARROW = [
    "X...........",
    "XX..........",
    "XWX.........",
    "XWWX........",
    "XWWWX.......",
    "XWWWWX......",
    "XWWWWWX.....",
    "XWWWWWWX....",
    "XWWWWWWWX...",
    "XWWWWWWWWX..",
    "XWWWWWXXXXX.",
    "XWWXWWX.....",
    "XWX.XWWX....",
    "XX..XWWX....",
    "X....XWWX...",
    ".....XWWX...",
    "......XWWX..",
    "......XWWX..",
    ".......XX...",
];
const CURSOR_PIXEL = 3;
const CURSOR_POINTS_WIDE = 960;

async function writeCursorShape(folder: string): Promise<string> {
    const width = CURSOR_ARROW[0].length * CURSOR_PIXEL;
    const height = CURSOR_ARROW.length * CURSOR_PIXEL;
    const canvas = new Canvas(width, height, 4);

    for (const [row, line] of CURSOR_ARROW.entries()) {
        for (const [column, cell] of [...line].entries()) {
            if (cell !== ".") {
                canvas.fill(
                    column * CURSOR_PIXEL,
                    row * CURSOR_PIXEL,
                    CURSOR_PIXEL,
                    CURSOR_PIXEL,
                    cell === "X" ? "0x000000" : "0xffffff"
                );
            }
        }
    }

    const proc = Bun.spawn(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgba",
            "-s",
            `${width}x${height}`,
            "-i",
            "pipe:0",
            "-frames:v",
            "1",
            "-f",
            "image2pipe",
            "-vcodec",
            "png",
            "-",
        ],
        { stdin: "pipe", stdout: "pipe", stderr: "pipe" }
    );
    const finished = ffmpegFinished(proc, readAll(proc.stdout), "cursor arrow");
    proc.stdin.write(canvas.data);
    await proc.stdin.end();
    const png = await finished;
    const id = createHash("sha1").update(png).digest("hex").slice(0, 12);
    const shapes = join(folder, "cursor-shapes");
    mkdirSync(shapes, { recursive: true });
    await Bun.write(join(shapes, `${id}.png`), png);
    await Bun.write(
        join(shapes, `${id}.json`),
        `${SafeJSON.stringify({ width: width / 2, height: height / 2, hotX: 0, hotY: 0 })}\n`
    );
    return id;
}

function easeInOut(value: number): number {
    return value < 0.5 ? 2 * value * value : 1 - (-2 * value + 2) ** 2 / 2;
}

/** The cursor track: a row every 1/60 s while the pointer moves, the clicks on their row, the shortcuts as `key`. */
function cursorRows(shape: string): Array<Record<string, number | string>> {
    const rows: Array<Record<string, number | string>> = [];
    const step = 1000 / 60;
    let last = "";
    const position = (seconds: number): { x: number; y: number } => {
        const next = WAYPOINTS.findIndex((point) => point.t >= seconds);

        if (next <= 0) {
            return WAYPOINTS[Math.max(0, next)];
        }

        const from = WAYPOINTS[next - 1];
        const to = WAYPOINTS[next];
        const moveStart = Math.max(from.t, to.t - 1.1);

        if (seconds <= moveStart) {
            return { x: from.x, y: from.y };
        }

        const progress = easeInOut((seconds - moveStart) / (to.t - moveStart));
        return { x: from.x + (to.x - from.x) * progress, y: from.y + (to.y - from.y) * progress };
    };
    const normal = (point: { x: number; y: number }) => ({
        x: Math.round((point.x / WIDTH) * 10_000) / 10_000,
        y: Math.round((point.y / HEIGHT) * 10_000) / 10_000,
    });

    for (let ms = 0; ms <= DURATION_S * 1000; ms += step) {
        const point = normal(position(ms / 1000));
        const key = `${point.x}:${point.y}`;

        if (key === last) {
            continue;
        }

        last = key;
        rows.push(
            rows.length === 0
                ? { t: Math.round(ms), ...point, shape, pw: CURSOR_POINTS_WIDE }
                : { t: Math.round(ms), ...point }
        );
    }

    for (const click of CLICKS) {
        rows.push({ t: Math.round(click.t * 1000), ...normal(click), click: "left" });
    }

    for (const shortcut of SHORTCUTS) {
        rows.push({ t: Math.round(shortcut.t * 1000), ...normal(position(shortcut.t)), key: shortcut.key });
    }

    return rows.sort((a, b) => Number(a.t) - Number(b.t));
}

function transcriptFile(): { text: string; segments: Array<Record<string, unknown>> } {
    const segments = TRANSCRIPT.map((line) => {
        const words = line.text.split(/\s+/);
        const step = (line.end - line.start) / words.length;
        return {
            speaker: line.speaker,
            start: line.start,
            end: line.end,
            text: line.text,
            words: words.map((word, index) => ({
                word,
                start: Math.round((line.start + index * step) * 1000) / 1000,
                end: Math.round((line.start + (index + 1) * step) * 1000) / 1000,
            })),
        };
    });
    return { text: TRANSCRIPT.map((line) => line.text).join(" "), segments };
}

const EDIT_OPS: EditOp[] = [
    { op: "zoom", from: 10.5, to: 17.5, scale: 1.8, focus: { x: 0.26, y: 0.24 } },
    {
        op: "redact",
        from: 8,
        to: 36,
        rect: { x: 0.4437, y: 0.7833, width: 0.2083, height: 0.1833 },
        style: "blur",
        label: "Customer emails",
    },
    { op: "text", from: 38, to: 44, text: "Failed payments down 70% after the retry fix" },
    { op: "clicks" },
    { op: "keys" },
];

async function buildEdit(folder: string): Promise<EditProject> {
    const opened = await openProject(folder);
    const edit = await computeEdit({ project: opened.project, ops: EDIT_OPS, fresh: opened.fresh });
    return writeProject(opened.path, edit.project, "recording-sandbox");
}

async function makeRecording(outInput: string): Promise<void> {
    const folder = resolve(outInput);

    if (existsSync(folder) && readdirSync(folder).length > 0) {
        throw new Error(`${folder} is not empty; give --out a new or empty folder`);
    }

    mkdirSync(folder, { recursive: true });
    const movie = join(folder, "screen.mp4");
    await renderMovie({ movie });
    const info = await probeVideo({ input: movie });
    const shape = await writeCursorShape(folder);
    const rows = cursorRows(shape);
    await Bun.write(join(folder, "cursor.jsonl"), `${rows.map((row) => SafeJSON.stringify(row)).join("\n")}\n`);
    await Bun.write(
        transcriptCachePath(movie),
        `${SafeJSON.stringify({ ...transcriptFile(), language: "en" }, null, 2)}\n`
    );

    const started = new Date();
    const id = `video-sandbox-${started.toISOString().slice(0, 19).replace(/[T:]/g, "-")}`;
    const manifest: RecordingManifest = recordingManifestSchema.parse({
        version: 1,
        id,
        title: "Northwind Console walkthrough (sample)",
        startedAt: started.toISOString(),
        endedAt: new Date(started.getTime() + DURATION_S * 1000).toISOString(),
        displays: [{ id: 1, name: "Sample display" }],
        settings: {
            kind: "video",
            target: { kind: "display", screenIndex: 0, name: "Sample display" },
            fps: FPS,
            audio: { sources: [] },
            cursor: "drawn",
            shortcuts: true,
            video: { file: "screen.mp4", durationMs: Math.round(info.durationUs / 1000) },
            outcome: "done",
            markers: MARKERS,
        },
        frames: [],
        warnings: [],
    });
    atomicWriteFileSync(join(folder, RECORDING_MANIFEST), `${SafeJSON.stringify(manifest, null, 2)}\n`);
    const project = await buildEdit(folder);

    log.info({ folder, durationUs: info.durationUs, cursorRows: rows.length }, "sandbox recording written");
    out.println(`Sandbox recording written: ${folder}`);
    out.println(
        `  ${Math.round(info.durationUs / 1000) / 1000} s, ${info.width}x${info.height}, ${rows.length} cursor rows, ` +
            `${TRANSCRIPT.length} transcript lines, ${MARKERS.length} markers, edit revision ${project.revision}`
    );
    out.println("Open it in the editor:");
    out.println(`  tools recorder edit ${folder}`);
}

/** Runs this script again with a temporary `GENESIS_TOOLS_HOME`, so no part of it writes the real `~/.genesis-tools`. */
async function runInSandboxHome(): Promise<number> {
    const home = mkdtempSync(join(tmpdir(), "recording-sandbox-home-"));

    try {
        const proc = Bun.spawn([process.execPath, import.meta.path, ...process.argv.slice(2)], {
            env: { ...process.env, GENESIS_TOOLS_HOME: home },
            stdin: "inherit",
            stdout: "inherit",
            stderr: "inherit",
        });
        return await proc.exited;
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
}

async function main(): Promise<void> {
    const program = new Command()
        .name("recording-sandbox")
        .description("Write an invented screen recording folder for the recording editor, with no real screen content")
        .requiredOption("--out <dir>", "the new recording folder (empty or missing)")
        .action(async (flags: { out: string }) => {
            try {
                await makeRecording(flags.out);
            } catch (error) {
                log.error({ error }, "recording sandbox failed");
                out.printlnErr(error instanceof Error ? error.message : String(error));
                process.exitCode = 1;
            }
        });
    await runTool(program, { tool: "recording-sandbox" });
}

if (import.meta.main) {
    if (env.tools.hasExplicitHome()) {
        await main();
    } else {
        process.exitCode = await runInSandboxHome();
    }
}
