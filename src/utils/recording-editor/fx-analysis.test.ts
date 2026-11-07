import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { anchorTimeUs, movieEvents, nearestEvent } from "./events";
import { blockShifts } from "./motion";
import {
    findPrivateText,
    ibanValid,
    luhnValid,
    type MotionModel,
    maskPrivate,
    privateHits,
    privateMatcher,
    redactionBoxAt,
    type ScreenTextFrame,
    type TrackKey,
    textHits,
    textMatcher,
} from "./private-data";
import {
    applyOp,
    describeProject,
    editOpSchema,
    editProjectSchema,
    exportToOutputUs,
    hidingOf,
    type OpFacts,
    opPlacementWarnings,
    parseProject,
    sourceTimeOf,
    wholeProject,
} from "./project";
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

describe("moving text: the content's motion carries a hit (round 6)", () => {
    const frame = (ms: number, lines: ScreenTextFrame["lines"]): ScreenTextFrame => ({
        atUs: ms * 1000,
        untilUs: (ms + 200) * 1000,
        lines,
    });
    const row = (text: string, y: number) => ({ text, x: 0.1, y, width: 0.3, height: 0.03 });
    /** A list that scrolls up by `travel` of the picture from 0.2 s to 0.8 s, fast first and slow at the end. */
    const scroll = (travel: number, options: { lostAfterUs?: number } = {}): MotionModel => {
        const offset = (us: number) => {
            const u = Math.min(1, Math.max(0, (us - 200_000) / 600_000));
            return -travel * (1 - (1 - u) ** 2);
        };
        return {
            moving: (fromUs, toUs) => Math.max(fromUs, toUs) > 200_000 && Math.min(fromUs, toUs) < 800_000,
            movingArea: () => ({ x: 0, y: 0, width: 1, height: 1 }),
            changeEdge: (_box, atUs) => atUs,
            carry: (box, fromUs, toUs) => {
                const direction = toUs >= fromUs ? 1 : -1;
                const keys: TrackKey[] = [];

                for (
                    let at = fromUs + direction * 33_333;
                    direction > 0 ? at <= toUs : at >= toUs;
                    at += direction * 33_333
                ) {
                    if (options.lostAfterUs !== undefined && at > options.lostAfterUs) {
                        const last = keys.at(-1) ?? { ...box, atUs: fromUs };
                        return { keys, reachedUs: at, box: last, end: "lost" };
                    }

                    keys.push({ ...box, atUs: Math.round(at), y: box.y + offset(at) - offset(fromUs) });
                }

                const last = keys.at(-1) ?? { ...box, atUs: fromUs };
                return { keys, reachedUs: toUs, box: last, end: "reached" };
            },
        };
    };
    const matcher = textMatcher({ text: "Orla Fictive" });

    test("a read OCR missed in the middle of a scroll is bridged by the motion, with a key for every picture", () => {
        // OCR reads the name still at 0.8 of the picture, then nothing while it moves, then at rest 0.6 higher.
        const frames = [
            frame(0, [row("Orla Fictive 777 123 456", 0.8)]),
            frame(200, [row("Orla Fictive 777 123 456", 0.8)]),
            frame(400, []),
            frame(600, []),
            frame(800, [row("Orla Fictive 777 123 456", 0.2)]),
        ];
        const [hit, ...rest] = textHits(frames, matcher, { motion: scroll(0.6) });
        expect(rest).toEqual([]);
        expect(hit.uncertain).toBeUndefined();
        // Halfway through the move the part is where the motion put the text, not on a straight line between reads.
        const placed = redactionBoxAt({ ...hit.box, track: hit.keys }, 400_000);
        const read = hit.keys[0];
        expect(Math.abs(placed.y - (read.y - 0.6 * (1 - (1 - 1 / 3) ** 2)))).toBeLessThan(0.01);
        // Without the motion the 0.6 jump is two hits and the move between them is not hidden.
        expect(textHits(frames, matcher).length).toBe(2);
    });

    test("a read the motion does not lead to is another text; a gap it cannot follow hides the band between", () => {
        const frames = [frame(0, [row("Orla Fictive", 0.8)]), frame(200, [row("Orla Fictive", 0.8)])];
        // The motion carries it to 0.2, so a read at 0.5 is a second copy of the name, not this one.
        expect(
            textHits([...frames, frame(800, [row("Orla Fictive", 0.5)])], matcher, { motion: scroll(0.6) }).length
        ).toBe(2);
        // The motion is lost at 0.4 s: the two reads stay apart, and the band from 0.8 up to 0.2 is hidden between them.
        const lost = textHits([...frames, frame(800, [row("Orla Fictive", 0.2)])], matcher, {
            motion: scroll(0.6, { lostAfterUs: 400_000 }),
        });
        const band = lost
            .flatMap((hit) => hit.uncertain ?? [])
            .find((one) => one.fromUs <= 300_000 && one.toUs >= 700_000);
        expect(band && band.box.y <= 0.2 && band.box.y + band.box.height >= 0.83).toBe(true);
        const before = wholeProject(source);
        const edited = applyOp(before, op({ op: "hideText", text: "Orla Fictive" }), { textHits: lost });
        expect(
            edited.redactions?.some((part) => part.hide?.uncertain && part.label === "Text (auto) (uncertain)")
        ).toBe(true);
        expect(hidingOf(before, edited).uncertain.length).toBeGreaterThan(0);
        expect(opPlacementWarnings(op({ op: "hideText", text: "Orla Fictive" }), before, edited)[0]).toMatch(
            /could not be followed/
        );
    });

    test('unit "line" hides the whole OCR line of a match; "match" only the matched words; a pattern is per line', () => {
        const line = { text: "Orla Fictive   777 123 456", x: 0.1, y: 0.5, width: 0.4, height: 0.03 };
        const [word] = textHits([frame(0, [line])], textMatcher({ text: "orla fictive" }));
        const [whole] = textHits([frame(0, [line])], textMatcher({ text: "orla fictive", unit: "line" }));
        expect(word.box.x + word.box.width).toBeLessThan(0.35);
        expect(whole.box.x).toBeLessThanOrEqual(0.1);
        expect(whole.box.x + whole.box.width).toBeGreaterThanOrEqual(0.5);
        // ^ anchors to the OCR line, not to the screen: the number starts no line here.
        expect(textMatcher({ pattern: "^\\d{3} \\d{3}" })(line.text)).toEqual([]);
        expect(textMatcher({ pattern: "^orla" })(line.text).length).toBe(1);
        expect(
            applyOp(wholeProject(source), op({ op: "hideText", text: "Orla Fictive", unit: "line" }), {
                textHits: [whole],
            }).redactions?.[0].width
        ).toBeGreaterThan(0.39);
    });

    test("texts and patterns find several in one pass, each its own hit, and a refusal names them all", () => {
        const frames = [
            frame(0, [row("Orla Fictive", 0.2), row("Bram Sample", 0.4), row("call 606 000 111", 0.6)]),
            frame(200, [row("Orla Fictive", 0.2), row("Bram Sample", 0.4), row("call 606 000 111", 0.6)]),
        ];
        const several = textMatcher({ texts: ["orla fictive", "bram sample"], patterns: ["\\d{3} \\d{3} \\d{3}"] });
        const hits = textHits(frames, several);
        expect(hits.map((hit) => Math.round(hit.keys[0].y * 10) / 10)).toEqual([0.2, 0.4, 0.6]);
        expect(() =>
            applyOp(wholeProject(source), op({ op: "hideText", texts: ["Nobody Here"], patterns: ["^zzz"] }), {
                textHits: [],
            })
        ).toThrow(/"Nobody Here" or \/\^zzz\//);
        expect(() => textMatcher({ texts: [], patterns: [] })).toThrow(/give text/);
    });

    test("an export moment maps to output seconds after the intro card, and to source seconds across a cut", () => {
        // A 3 s intro card, and source 10 to 20 s cut out: export 15 s is output 12 s is source 22 s.
        const edited = applyOp(
            applyOp(wholeProject(source), op({ op: "cut", from: 10, to: 20 })),
            op({ op: "introCard", title: "Demo", seconds: 3 })
        );
        expect(exportToOutputUs(edited, 1_000_000)).toBeUndefined();
        const out = exportToOutputUs(edited, 15_000_000);
        expect(out).toBe(12_000_000);
        expect(sourceTimeOf(edited, out ?? 0)).toBe(22_000_000);
        expect(exportToOutputUs(edited, 3_000_000 + 50_000_001)).toBeUndefined();
    });

    test("info() names each part's kind and the hide request that made it", () => {
        const hits = textHits([frame(0, [row("Orla Fictive", 0.2)])], textMatcher({ texts: ["Orla Fictive"] }));
        const hidden = applyOp(
            applyOp(wholeProject(source), op({ op: "hideText", texts: ["Orla Fictive"], unit: "line" }), {
                textHits: hits,
            }),
            op({ op: "spotlight", from: 1, to: 2, rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } })
        );
        const parts = describeProject(hidden, "/movies/screen.edit.json").redactions;
        expect(parts.map((part) => part.kind)).toEqual(["hidden", "spotlight"]);
        expect(parts[0].hide).toEqual({
            by: "hideText",
            hit: hits[0].id,
            request: { texts: ["Orla Fictive"], unit: "line" },
        });
        expect(parts[1].hide).toBeUndefined();
    });

    test("unhide takes a hide back and forgets it, so the same hide runs again; unredact forgets its part too", () => {
        const hits = textHits(
            [frame(0, [row("Orla Fictive", 0.2), row("Bram Sample", 0.5)])],
            textMatcher({ texts: ["Orla Fictive", "Bram Sample"] })
        );
        const hide = op({ op: "hideText", texts: ["Orla Fictive", "Bram Sample"] });
        const drawn = applyOp(
            wholeProject(source),
            op({ op: "redact", from: 1, to: 2, rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 } })
        );
        const hidden = applyOp(drawn, hide, { textHits: hits });
        expect(hidden.redactions?.length).toBe(3);
        // Before round 6, a second hide after unredact answered "nothing changed": the hit stayed applied.
        const [first] = (hidden.redactions ?? []).filter((part) => part.hide);
        const unredacted = applyOp(hidden, op({ op: "unredact", id: first.id }));
        expect(unredacted.privacy?.applied).not.toContain(first.hide?.hit);
        expect(applyOp(unredacted, hide, { textHits: hits }).redactions?.length).toBe(3);
        // unhide by a text of the request takes back every part that request made; the hand-drawn part stays.
        const back = applyOp(hidden, op({ op: "unhide", text: "orla  fictive" }));
        expect(back.redactions?.length).toBe(1);
        expect(back.privacy?.applied).toEqual([]);
        expect(applyOp(back, hide, { textHits: hits }).redactions?.length).toBe(3);
        expect(applyOp(hidden, op({ op: "unhide", ids: [hits[1].id] })).redactions?.length).toBe(2);
        expect(applyOp(hidden, op({ op: "unhide", all: true })).redactions?.length).toBe(1);
        expect(() => applyOp(hidden, op({ op: "unhide", pattern: "^nope" }))).toThrow(/no hidden part was made/);
        expect(() => applyOp(hidden, op({ op: "unhide" }))).toThrow(/needs text, pattern, ids/);
    });

    test("block matching finds a scroll's shift and leaves a still picture still", () => {
        const width = 96;
        const height = 96;
        const rows = (offset: number) =>
            Uint8Array.from({ length: width * height }, (_, index) => {
                const y = Math.floor(index / width) + offset;
                const x = index % width;
                return (y * 7 + x * 3) % 17 < 6 || (Math.floor(y / 5) + Math.floor(x / 9)) % 3 === 0 ? 230 : 30;
            });
        // The content moves 9 pixels up: what was at row y + 9 is at row y.
        const moved = blockShifts({ previous: rows(0), current: rows(9), width, height });
        const found = [...moved.dy].filter((_, index) => moved.ok[index] === 2);
        expect(found.length).toBeGreaterThan(4);
        expect(found.every((dy) => Math.abs(dy + 9) < 0.6)).toBe(true);
        const still = blockShifts({ previous: rows(0), current: rows(0), width, height });
        expect([...still.ok].every((state) => state === 1)).toBe(true);
    });
});
