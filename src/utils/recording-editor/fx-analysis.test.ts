import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { anchorTimeUs, movieEvents, nearestEvent } from "./events";
import {
    findPrivateText,
    ibanValid,
    luhnValid,
    maskPrivate,
    privateHits,
    privateMatcher,
    type ScreenTextFrame,
    textHits,
    textMatcher,
} from "./private-data";
import { applyOp, editOpSchema, editProjectSchema, type OpFacts, parseProject, wholeProject } from "./project";
import {
    type ChangeStep,
    compareFrames,
    fixedAreas,
    proposedSpeed,
    subtractRanges,
    verticalShift,
    waitStretches,
} from "./waits";

// Every value here is invented: example.com mail, test card and IBAN numbers, made-up tokens.
const source = { video: "/movies/screen.mp4", durationUs: 60_000_000, width: 1920, height: 1080 };
const op = (raw: unknown) => editOpSchema.parse(raw);

describe("private data patterns", () => {
    test("finds each kind and nothing in ordinary text", () => {
        const kinds = (text: string) => findPrivateText(text).map((match) => match.kind);
        expect(kinds("mail alice@example.com now")).toEqual(["email"]);
        expect(kinds("key sk-ant-api03-AbCdEfGhIjKlMnOpQrSt")).toEqual(["token"]);
        expect(kinds("token ghp_0123456789abcdefABCDEF0123")).toEqual(["token"]);
        expect(kinds("API_KEY=Zx81kq0pLmw2")).toEqual(["token"]);
        expect(kinds("call +420 601 234 567")).toEqual(["phone"]);
        expect(kinds("pay GB82 WEST 1234 5698 7654 32")).toEqual(["iban"]);
        expect(kinds("card 4111 1111 1111 1111")).toEqual(["card"]);
        expect(kinds("server 192.168.100.1 build 1.2.3")).toEqual([]);
        expect(kinds("commit 3f1c2e9a0b7d4c6e8f1a2b3c4d5e6f7a8b9c0d1e")).toEqual([]);
        expect(kinds("card 4111 1111 1111 1112")).toEqual([]);
    });

    test("checks cards and IBANs and never prints a whole value", () => {
        expect(luhnValid("4111111111111111")).toBe(true);
        expect(luhnValid("0000000000000000")).toBe(false);
        expect(ibanValid("GB82WEST12345698765432")).toBe(true);
        expect(ibanValid("GB82WEST12345698765433")).toBe(false);
        const masked = maskPrivate("alice@example.com");
        expect(masked.startsWith("al")).toBe(true);
        expect(masked).not.toContain("example");
    });
});

describe("private hits over time", () => {
    const line = (text: string, y = 0.5) => ({ text, x: 0.1, y, width: 0.4, height: 0.02 });
    const frame = (second: number, lines: ScreenTextFrame["lines"]): ScreenTextFrame => ({
        atUs: second * 1_000_000,
        untilUs: (second + 1) * 1_000_000,
        lines,
    });

    test("one hit while the value stays in place, bridging a missed frame; a moved value is a new hit", () => {
        const frames = [
            frame(0, [line("Signed in as alice@example.com")]),
            frame(1, [line("Signed in as alice@example.com")]),
            frame(2, []),
            frame(3, [line("Signed in as alice@example.com")]),
            frame(10, [line("Signed in as alice@example.com", 0.1)]),
        ];
        const hits = privateHits(frames);
        expect(hits.map((hit) => [hit.kind, hit.fromUs, hit.toUs])).toEqual([
            ["email", 0, 4_000_000],
            ["email", 9_500_000, 11_000_000],
        ]);
        // The box covers the address, not the words before it.
        expect(hits[0].box.x).toBeGreaterThan(0.2);
        expect(hits[0].box.x + hits[0].box.width).toBeLessThanOrEqual(0.52);
        expect(SafeJSON.stringify(hits)).not.toContain("alice@example.com");
        expect(privateHits(frames).map((hit) => hit.id)).toEqual(hits.map((hit) => hit.id));
    });

    test("hidePrivate adds one blurred part per hit, once", () => {
        const hits = privateHits([frame(2, [line("alice@example.com")]), frame(5, [line("4111 1111 1111 1111", 0.8)])]);
        const facts: OpFacts = { privateHits: hits };
        const once = applyOp(wholeProject(source), op({ op: "hidePrivate" }), facts);
        expect(once.redactions?.map((part) => [part.style, part.label, part.startUs])).toEqual([
            ["blur", "Email (auto)", 2_000_000],
            ["blur", "Card number (auto)", 4_500_000],
        ]);
        expect(once.privacy?.applied).toEqual(hits.map((hit) => hit.id));
        expect(applyOp(once, op({ op: "hidePrivate" }), facts)).toBe(once);
        const cards = applyOp(wholeProject(source), op({ op: "hidePrivate", kinds: ["card"], style: "black" }), facts);
        expect(cards.redactions?.map((part) => part.style)).toEqual(["black"]);
        expect(() => applyOp(wholeProject(source), op({ op: "hidePrivate", ids: ["pnope"] }), facts)).toThrow(
            /no private hit pnope/
        );
        expect(() => applyOp(wholeProject(source), op({ op: "hidePrivate" }))).toThrow(/screen text/);
    });
});

describe("typing and waiting stretches", () => {
    test("compareFrames counts changed cells and their box", () => {
        const width = 40;
        const height = 20;
        const a = new Uint8Array(width * height);
        const b = Uint8Array.from(a);

        for (let y = 2; y < 6; y++) {
            for (let x = 22; x < 26; x++) {
                b[y * width + x] = 200;
            }
        }

        expect(compareFrames(a, a, width, height).changed).toBe(0);
        expect(compareFrames(a, b, width, height)).toEqual({
            changed: 1,
            cells: 8,
            box: { x0: 2, y0: 0, x1: 2, y1: 0 },
            mask: "40",
        });
    });

    const quiet: ChangeStep = { changed: 1, cells: 144, box: { x0: 3, y0: 4, x1: 5, y1: 4 } };
    const busy: ChangeStep = { changed: 90, cells: 144, box: { x0: 0, y0: 0, x1: 15, y1: 8 } };
    const grid = { columns: 16, rows: 9 };

    test("a long quiet run is a typing stretch with a proposed speed; busy moments split it", () => {
        // 4 busy steps, 40 quiet (10 s), 4 busy.
        const steps = [...Array(4).fill(busy), ...Array(40).fill(quiet), ...Array(4).fill(busy)];
        const [stretch] = waitStretches({ steps, fps: 4, grid, minUs: 4_000_000, maxArea: 0.06 });
        expect(stretch).toMatchObject({ kind: "typing", fromUs: 1_300_000, toUs: 10_700_000, speed: 5 });
        expect(stretch.region).toEqual({ x: 0.188, y: 0.444, width: 0.188, height: 0.111 });
        const split = waitStretches({
            steps,
            fps: 4,
            grid,
            minUs: 4_000_000,
            maxArea: 0.06,
            busyUs: [[3_000_000, 4_000_000]],
        });
        // 1.0 to 3.0 s is too short once 0.3 s stays at each end; 4.0 to 11.0 s is kept.
        expect(split.map((wait) => [wait.fromUs, wait.toUs, wait.speed])).toEqual([[4_300_000, 10_700_000, 4]]);
        expect(proposedSpeed(4_000_000)).toBe(4);
        expect(proposedSpeed(30_000_000)).toBe(8);
        expect(subtractRanges([[0, 10]], [[2, 4]])).toEqual([
            [0, 2],
            [4, 10],
        ]);
    });

    test("speedUpWaits speeds each stretch and turns the badge on", () => {
        const waits = [
            { id: "w1", kind: "still" as const, fromUs: 2_000_000, toUs: 10_000_000, speed: 4 },
            { id: "w2", kind: "typing" as const, fromUs: 20_000_000, toUs: 36_000_000, speed: 8 },
        ];
        const edited = applyOp(wholeProject(source), op({ op: "speedUpWaits" }), { waits });
        expect(edited.clips.map((clip) => clip.speed)).toEqual([1, 4, 1, 8, 1]);
        expect(edited.autoSpeed).toEqual({ badge: true, position: "top-right" });
        const one = applyOp(wholeProject(source), op({ op: "speedUpWaits", ids: ["w2"], speed: 6 }), { waits });
        expect(one.clips.map((clip) => clip.speed)).toEqual([1, 6, 1]);
        const hidden = applyOp(edited, op({ op: "autoSpeed", badge: false, position: "bottom-left" }));
        expect(hidden.autoSpeed).toEqual({ badge: false, position: "bottom-left" });
    });
});

describe("smooth cursor and old files", () => {
    test("cursorSmooth needs a drawn cursor and turns off again", () => {
        const folder = mkdtempSync(join(tmpdir(), "gt-fxb-"));
        const drawn = join(folder, "cursor.jsonl");
        writeFileSync(drawn, '{"t":0,"x":0.5,"y":0.5,"shape":"abc","pw":1440}\n');
        const project = wholeProject({ ...source, cursor: drawn });
        const on = applyOp(project, op({ op: "cursorSmooth", strength: 0.8 }));
        expect(on.cursorSmooth).toEqual({ strength: 0.8, jitterPx: 3, idleFadeSeconds: 2 });
        expect(applyOp(on, op({ op: "cursorSmooth", enabled: false })).cursorSmooth).toBeUndefined();
        const system = join(folder, "system.jsonl");
        writeFileSync(system, '{"t":0,"x":0.5,"y":0.5}\n');
        expect(() => applyOp(wholeProject({ ...source, cursor: system }), op({ op: "cursorSmooth" }))).toThrow(
            /system cursor/
        );
    });

    test("an edit file from before the new keys loads with them off", () => {
        const old = SafeJSON.stringify({ source, clips: [{ id: "c1", fromUs: 0, toUs: source.durationUs }] });
        const project = parseProject(old, "edit.json");
        expect([project.privacy, project.cursorSmooth, project.autoSpeed]).toEqual([undefined, undefined, undefined]);
        expect(editProjectSchema.parse({ ...project, autoSpeed: {} }).autoSpeed).toEqual({
            badge: true,
            position: "top-right",
        });
    });
});

describe("tracked text, exclusions and events", () => {
    const frame = (ms: number, lines: ScreenTextFrame["lines"]): ScreenTextFrame => ({
        atUs: ms * 1000,
        untilUs: (ms + 200) * 1000,
        lines,
    });
    const row = (text: string, y: number) => ({ text, x: 0.1, y, width: 0.3, height: 0.03 });

    test("a value OCR read with a space still matches, and a scrolling one is one hit with keyframes", () => {
        const matcher = textMatcher({ text: "alice@example.com" });
        expect(matcher("Contact alice@example. com").map((match) => [match.start, match.end])).toEqual([[8, 26]]);
        expect(privateMatcher()("alice@example. com").map((match) => match.kind)).toEqual(["email"]);
        expect(privateMatcher(["Bob Builder"])("call bob builder now").map((match) => match.kind)).toEqual(["name"]);
        // It scrolls up 0.1 of the picture per 0.2 s sample, then rests.
        const frames = [
            frame(0, []),
            frame(200, [row("alice@example.com", 0.9)]),
            frame(400, [row("alice@example.com", 0.8)]),
            frame(600, [row("alice@example. com", 0.7)]),
            frame(800, [row("alice@example.com", 0.7)]),
            frame(1000, [row("alice@example.com", 0.7)]),
            frame(1200, []),
        ];
        const [hit, ...rest] = textHits(frames, matcher);
        expect(rest).toEqual([]);
        expect([hit.fromUs, hit.toUs]).toEqual([100_000, 1_200_000]);
        expect(hit.keys.map((key) => [key.atUs, Math.round(key.y * 100) / 100])).toEqual([
            [200_000, 0.89],
            [400_000, 0.79],
            [600_000, 0.69],
            [1_000_000, 0.69],
        ]);
        // An excluded area is never searched.
        expect(textHits(frames, matcher, { exclude: [{ x: 0, y: 0.6, width: 1, height: 0.4 }] })).toEqual([]);
    });

    test("hideText adds a part that follows its keyframes and leaves the excluded area visible", () => {
        const hits = textHits(
            [frame(2000, [row("alice@example.com", 0.9)]), frame(2200, [row("alice@example.com", 0.6)])],
            textMatcher({ text: "alice@example.com" })
        );
        const edited = applyOp(
            wholeProject(source),
            op({ op: "hideText", text: "alice@example.com", exclude: [{ x: 0.4, y: 0.75, width: 0.2, height: 0.1 }] }),
            { textHits: hits }
        );
        const [part] = edited.redactions ?? [];
        expect(part.track?.map((key) => key.atUs)).toEqual([2_000_000, 2_200_000]);
        expect(part.exclude).toEqual([{ x: 0.4, y: 0.75, width: 0.2, height: 0.1 }]);
        expect(part.label).toBe("Text (auto)");
        expect(() =>
            applyOp(wholeProject(source), op({ op: "hideText", text: "alice@example.com", from: 30 }), {
                textHits: hits,
            })
        ).toThrow(/does not show/);
    });

    test("a toast that stays still while the list scrolls is a fixed area; a scroll and a scene are events", () => {
        const grid = { columns: 4, rows: 3 };
        // Every cell changes while it scrolls but cell 5 (row 1, column 1): the toast.
        const allBut5 = (() => {
            const digits = [0xf, 0xf, 0xf];
            digits[1] &= ~(1 << 1);
            return digits.map((digit) => digit.toString(16)).join("");
        })();
        const scrolling: ChangeStep = { changed: 11, cells: 12, mask: allBut5, dy: -3 };
        const still: ChangeStep = { changed: 0, cells: 12 };
        const scene: ChangeStep = { changed: 12, cells: 12, mask: "fff" };
        const steps = [still, still, still, still, still, scrolling, scrolling, scrolling, still, scene, still];
        const areas = fixedAreas({ steps, fps: 4, grid, fromUs: 1_250_000, toUs: 2_000_000 });
        expect(areas.map((area) => [Math.round(area.x * 100), Math.round(area.y * 100)])).toEqual([[29, 38]]);
        const events = movieEvents({
            steps,
            fps: 4,
            pictureHeight: 30,
            clicks: [{ ms: 500, x: 0.5, y: 0.5 }],
            taps: [{ at: 2.6, x: 0.2, y: 0.8 }],
        });
        expect(events.map((event) => [event.kind, event.index, event.fromUs, event.toUs ?? null])).toEqual([
            ["still", 1, 0, 1_250_000],
            ["click", 1, 500_000, null],
            ["scroll", 1, 1_250_000, 2_000_000],
            ["scene", 1, 2_500_000, null],
            ["tap", 1, 2_600_000, null],
        ]);
        expect(events.find((event) => event.kind === "scroll")?.shift).toBe(-0.3);
        expect(anchorTimeUs(events, { event: "scene", index: 1, lead: -0.2 })).toBe(2_300_000);
        expect(anchorTimeUs(events, { event: "scroll", index: -1, end: true })).toBe(2_000_000);
        expect(() => anchorTimeUs(events, { event: "scene", index: 2 })).toThrow(/has 1/);
        expect(nearestEvent(events, 2_450_000, ["scene", "scroll"])?.atUs).toBe(2_500_000);
    });

    test("a shifted picture is a scroll; a new blob is not", () => {
        const width = 40;
        const height = 40;
        const stripes = (offset: number) =>
            Uint8Array.from({ length: width * height }, (_, index) =>
                Math.floor(index / width + offset) % 7 < 3 ? 220 : 20
            );
        expect(verticalShift(stripes(0), stripes(2), width, height)).toBe(-2);
        const blob = new Uint8Array(width * height);
        blob.fill(200, 20 * width, 22 * width);
        expect(verticalShift(new Uint8Array(width * height), blob, width, height)).toBe(0);
    });
});
