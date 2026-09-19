import { describe, expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { observationSchema } from "../decision/observation";
import { SIMULATOR_ACTIONS, swipeForScroll, UnsupportedSimulatorAction, verbsForAction } from "./driver";
import { clipToScreen, contains, dedupeElements, frameCentre, stableId, toObservedRows } from "./elements";
import { type IdbElement, idbArguments, parseIdbElements } from "./idb";
import { DEFAULT_SCREEN, observeSimulator, probePoints, screenFrom, withinBudget } from "./observe";
import { elementSignature, probedSignature, rematchElement, staleRefusalReason } from "./resolve";
import { parseDeviceList, parseLaunchPid } from "./simctl";

const SCREEN = { x: 0, y: 0, width: 402, height: 874 };

function element(overrides: Partial<IdbElement> & { frame: IdbElement["frame"] }): IdbElement {
    return { role: "AXButton", type: "Button", enabled: true, ...overrides };
}

const APP = element({
    role: "AXApplication",
    type: "Application",
    AXLabel: "Calendar",
    frame: { x: 0, y: 0, width: 402, height: 874 },
});

describe("idb argument building", () => {
    test("a point probe passes rounded device coordinates", () => {
        expect(idbArguments({ kind: "describe-point", x: 200.6, y: 462.2 }, "UDID")).toEqual([
            "idb",
            "ui",
            "describe-point",
            "--udid",
            "UDID",
            "201",
            "462",
        ]);
    });

    test("a swipe passes both endpoints", () => {
        expect(idbArguments({ kind: "swipe", fromX: 10, fromY: 20, toX: 30, toY: 40 }, "U")).toEqual([
            "idb",
            "ui",
            "swipe",
            "--udid",
            "U",
            "10",
            "20",
            "30",
            "40",
        ]);
    });

    test("text is passed verbatim, never shell-quoted by hand", () => {
        expect(idbArguments({ kind: "text", text: "a b 'c'" }, "U").at(-1)).toBe("a b 'c'");
    });
});

describe("parsing idb output", () => {
    test("reads a JSON array", () => {
        const parsed = parseIdbElements('[{"frame":{"x":1,"y":2,"width":3,"height":4},"AXLabel":"One"}]');
        expect(parsed).toHaveLength(1);
        expect(parsed[0].AXLabel).toBe("One");
    });

    test("reads one object per line", () => {
        const parsed = parseIdbElements(
            '{"frame":{"x":0,"y":0,"width":1,"height":1}}\n{"frame":{"x":1,"y":1,"width":1,"height":1}}'
        );
        expect(parsed).toHaveLength(2);
    });

    test("drops rows that do not parse rather than failing the whole read", () => {
        expect(parseIdbElements('not json\n{"frame":{"x":0,"y":0,"width":1,"height":1}}')).toHaveLength(1);
    });

    test("empty output is no elements, not an error", () => {
        expect(parseIdbElements("  ")).toEqual([]);
    });
});

describe("simctl parsing", () => {
    const raw = SafeJSON.stringify({
        devices: {
            "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [
                {
                    udid: "AAAA",
                    name: "iPhone test",
                    state: "Booted",
                    deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
                    isAvailable: true,
                },
                { udid: "BBBB", name: "iPad test", state: "Shutdown", isAvailable: true },
                { udid: "CCCC", name: "gone", state: "Shutdown", isAvailable: false },
            ],
        },
    });

    test("keeps available devices and flags the booted one", () => {
        const devices = parseDeviceList(raw);
        expect(devices.map((device) => device.udid)).toEqual(["AAAA", "BBBB"]);
        expect(devices[0].booted).toBe(true);
        expect(devices[0].runtime).toBe("iOS 26 5");
        expect(devices[1].booted).toBe(false);
    });

    test("a launch line yields the pid", () => {
        expect(parseLaunchPid("com.apple.mobilecal: 90266")).toBe(90266);
        expect(parseLaunchPid("no pid here")).toBeUndefined();
    });
});

describe("geometry", () => {
    test("stableId is deterministic and a positive integer", () => {
        const id = stableId("simulator-screen:UDID");
        expect(id).toBe(stableId("simulator-screen:UDID"));
        expect(Number.isInteger(id) && id > 0).toBe(true);
        expect(id).not.toBe(stableId("simulator-screen:OTHER"));
    });

    test("containment tolerates idb's float frames", () => {
        expect(contains({ x: 0, y: 0, width: 10, height: 10 }, { x: -0.4, y: 0, width: 10, height: 10 })).toBe(true);
        expect(contains({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 0, width: 10, height: 10 })).toBe(false);
    });

    test("a frame taller than the screen is clipped to what is visible", () => {
        const clipped = clipToScreen({ x: 63, y: 130, width: 339, height: 1237 }, SCREEN);
        expect(clipped).toEqual({ x: 63, y: 130, width: 339, height: 744 });
        // The tap point follows the clip, so it lands on a visible pixel.
        expect(frameCentre(clipped as { x: number; y: number; width: number; height: number }).y).toBeLessThan(874);
    });

    test("an entirely offscreen frame is dropped", () => {
        expect(clipToScreen({ x: 0, y: 900, width: 100, height: 50 }, SCREEN)).toBeUndefined();
    });

    test("the probe grid covers the screen and stays inside it", () => {
        const points = probePoints(SCREEN, 40);
        expect(points.length).toBe(220);
        expect(points.every(([x, y]) => x > 0 && x < 402 && y > 0 && y < 874)).toBe(true);
    });
});

describe("screenFrom", () => {
    // Regression: taking the largest element as the screen picked a 338x1237 scroll view, which
    // aimed the probe grid off the right edge and lost the Add button entirely.
    test("uses the application frame, not the largest element", () => {
        const scroller = element({ role: "AXGroup", frame: { x: 63, y: 130, width: 338, height: 1237 } });
        expect(screenFrom([APP, scroller])).toEqual(SCREEN);
    });

    test("falls back to a known device size when no application row is present", () => {
        expect(screenFrom([])).toEqual(DEFAULT_SCREEN);
    });
});

describe("row building", () => {
    const add = element({
        AXLabel: "Add",
        AXUniqueId: "add-plus-button",
        frame: { x: 345, y: 66, width: 37, height: 36 },
    });
    const toolbar = element({ role: "AXGroup", AXLabel: "Toolbar", frame: { x: 0, y: 788, width: 402, height: 86 } });
    const today = element({
        AXLabel: "Today",
        AXUniqueId: "today-button",
        frame: { x: 33, y: 803, width: 69, height: 38 },
    });

    test("the same element seen by several probes is kept once", () => {
        expect(dedupeElements([add, { ...add }, toolbar])).toHaveLength(2);
    });

    test("zero-area rows idb emits for an empty point are dropped", () => {
        expect(dedupeElements([element({ frame: { x: 0, y: 0, width: 0, height: 0 } })])).toHaveLength(0);
    });

    test("containment becomes depth, and the application root becomes the window", () => {
        const rows = toObservedRows([APP, add, toolbar, today], SCREEN, "Calendar");
        const window = rows[0];
        expect(window.role).toBe("AXWindow");
        expect(window.AXTitle).toBe("Calendar");
        expect(window.depth).toBe(0);
        const byLabel = new Map(rows.map((row) => [row.AXDescription ?? row.AXTitle, row]));
        expect(byLabel.get("Toolbar")?.depth).toBe(1);
        expect(byLabel.get("Today")?.depth).toBe(2);
        expect(byLabel.get("Add")?.AXIdentifier).toBe("add-plus-button");
    });

    test("indexes are unique and sequential, as the observation schema demands", () => {
        const rows = toObservedRows([APP, add, toolbar, today], SCREEN, "Calendar");
        expect(rows.map((row) => row.index)).toEqual(rows.map((_row, index) => index));
    });

    test("a control is offered AXPress; a plain group is not", () => {
        const rows = toObservedRows([APP, add, toolbar], SCREEN, "Calendar");
        const byLabel = new Map(rows.map((row) => [row.AXDescription ?? row.AXTitle, row]));
        expect(byLabel.get("Add")?.actions).toContain("AXPress");
        expect(byLabel.get("Toolbar")?.actions).not.toContain("AXPress");
    });

    test("a text field is marked settable so `type` is allowed on it", () => {
        const field = element({
            role: "AXTextField",
            type: "TextField",
            AXUniqueId: "title-field",
            frame: { x: 20, y: 200, width: 300, height: 40 },
        });
        const rows = toObservedRows([APP, field], SCREEN, "Calendar");
        expect(rows.find((row) => row.AXIdentifier === "title-field")?.valueSettable).toBe(true);
    });
});

describe("observeSimulator", () => {
    const add = element({
        AXLabel: "Add",
        AXUniqueId: "add-plus-button",
        frame: { x: 345, y: 66, width: 37, height: 36 },
    });

    async function observe(
        overrides: Parameters<typeof observeSimulator>[0] extends infer T ? Partial<T> : never = {}
    ) {
        return observeSimulator({
            udid: "UDID",
            deviceName: "iPhone test",
            probeStep: 200,
            probeConcurrency: 2,
            describeAllFn: async () => [APP],
            describePointFn: async ({ x, y }) =>
                x >= 345 && x <= 382 && y >= 66 && y <= 102 ? add : { frame: { x: 0, y: 0, width: 402, height: 874 } },
            ...overrides,
        });
    }

    test("produces an observation the shared schema accepts", async () => {
        const observation = await observe();
        expect(() => observationSchema.parse(observation)).not.toThrow();
        expect(observation.app).toBe("Calendar");
        expect(observation.scope).toBe("window");
        expect(observation.pid).toBeGreaterThan(0);
    });

    test("the probe finds a leaf that describe-all never reported", async () => {
        const observation = await observe({ probeStep: 18 });
        expect(observation.elements.some((row) => row.AXIdentifier === "add-plus-button")).toBe(true);
        expect(observation.probe?.points).toBeGreaterThan(0);
    });

    test("--no-probe reports only what describe-all returned, and says so", async () => {
        const observation = await observe({ probe: false });
        expect(observation.probe).toBeNull();
        expect(observation.elements.some((row) => row.AXIdentifier === "add-plus-button")).toBe(false);
    });

    test("a point budget truncates the sweep and reports it rather than pretending it is complete", async () => {
        const observation = await observe({ probeStep: 18, maxProbePoints: 5 });
        expect(observation.probe?.truncated).toBe(true);
        expect(observation.probe?.points).toBeLessThanOrEqual(5);
    });

    test("the window id follows the device, not the foreground app", async () => {
        const first = await observe();
        const second = await observe({
            describeAllFn: async () => [{ ...APP, AXLabel: "SpringBoard" }],
        });
        // Dismissing a system alert changes the root label. That must not read as an app swap.
        expect(second.window.id).toBe(first.window.id);
    });

    test("two reads of the same screen carry different snapshot tokens", async () => {
        expect((await observe()).snapshot).not.toBe((await observe()).snapshot);
    });
});

describe("action mapping", () => {
    const frame = { x: 100, y: 200, width: 40, height: 40 };

    test("a press is a tap at the observed frame centre, never a model's coordinates", () => {
        expect(verbsForAction({ action: "press", frame })).toEqual([{ kind: "tap", x: 120, y: 220 }]);
    });

    test("typing focuses the field first, then sends the text", () => {
        expect(verbsForAction({ action: "type", frame, value: "hello" })).toEqual([
            { kind: "tap", x: 120, y: 220 },
            { kind: "text", text: "hello" },
        ]);
    });

    test("typing without a value is refused", () => {
        expect(() => verbsForAction({ action: "type", frame })).toThrow(/exact supplied value/);
    });

    test("multi-line text is refused rather than silently truncated", () => {
        expect(() => verbsForAction({ action: "type", frame, value: "a\nb" })).toThrow(/single-line/);
    });

    test("a known key name becomes its HID code", () => {
        expect(verbsForAction({ action: "key", frame, parameters: { keys: "return" } })).toEqual([
            { kind: "key", keycode: 40 },
        ]);
    });

    test("an unknown key name is refused and lists what is known", () => {
        expect(() => verbsForAction({ action: "key", frame, parameters: { keys: "f13" } })).toThrow(
            /Unknown simulator key/
        );
    });

    test("an unsupported action is refused by name instead of doing something else", () => {
        expect(() => verbsForAction({ action: "paste", frame })).toThrow(UnsupportedSimulatorAction);
        expect(SIMULATOR_ACTIONS.has("paste")).toBe(false);
    });

    test("scrolling down drags the content up", () => {
        const scrollFrame = { x: 0, y: 100, width: 400, height: 600 };
        const swipe = swipeForScroll({ frame: scrollFrame, direction: "down", pages: 1 });
        expect(swipe.fromY).toBeGreaterThan(swipe.toY);
        expect(swipe.fromX).toBe(swipe.toX);
    });

    test("scrolling up drags the content down", () => {
        const swipe = swipeForScroll({ frame: { x: 0, y: 100, width: 400, height: 600 }, direction: "up", pages: 1 });
        expect(swipe.fromY).toBeLessThan(swipe.toY);
    });

    test("a swipe never leaves the element it was asked to scroll", () => {
        const scrollFrame = { x: 0, y: 100, width: 400, height: 600 };
        const swipe = swipeForScroll({ frame: scrollFrame, direction: "down", pixels: 100_000 });
        for (const y of [swipe.fromY, swipe.toY]) {
            expect(y).toBeGreaterThanOrEqual(scrollFrame.y);
            expect(y).toBeLessThanOrEqual(scrollFrame.y + scrollFrame.height);
        }
    });

    test("scroll needs a direction, and takes at most one distance", () => {
        expect(() => verbsForAction({ action: "scroll", frame })).toThrow(/requires parameters.direction/);
        expect(() =>
            verbsForAction({ action: "scroll", frame, parameters: { direction: "down", pages: 1, pixels: 10 } })
        ).toThrow(/at most one/);
    });
});

describe("freshness", () => {
    const row = (overrides: Record<string, unknown> = {}) => ({
        index: 1,
        depth: 1,
        role: "AXButton",
        AXIdentifier: "add-plus-button",
        AXDescription: "Add",
        x: 345,
        y: 66,
        width: 37,
        height: 36,
        ...overrides,
    });

    test("identity is the app's identifier when it set one", () => {
        expect(elementSignature(row())).toBe("id:add-plus-button");
    });

    test("without an identifier, identity is role plus label", () => {
        expect(elementSignature(row({ AXIdentifier: undefined }))).toBe("role:AXButton|label:Add");
    });

    test("the same element at the point is not stale", () => {
        const present: IdbElement = {
            role: "AXButton",
            AXUniqueId: "add-plus-button",
            AXLabel: "Add",
            frame: { x: 345, y: 66, width: 37, height: 36 },
        };
        expect(staleRefusalReason(row(), present)).toBeUndefined();
        expect(probedSignature(present)).toBe("id:add-plus-button");
    });

    test("a different element at the point refuses the act", () => {
        const present: IdbElement = {
            role: "AXButton",
            AXUniqueId: "cancel-button",
            AXLabel: "Cancel",
            frame: { x: 345, y: 66, width: 37, height: 36 },
        };
        expect(staleRefusalReason(row(), present)).toMatch(/the screen moved/);
    });

    test("a point idb cannot describe refuses the act rather than tapping blind", () => {
        expect(staleRefusalReason(row(), undefined)).toMatch(/could not describe/);
    });

    const observation = (elements: Array<Record<string, unknown>>) =>
        observationSchema.parse({
            ok: true,
            app: "Calendar",
            pid: 10,
            snapshot: "s",
            window: { id: 1, title: "t" },
            scope: "window",
            elements,
        });

    test("an element still on screen is re-resolved to its current index", () => {
        const fresh = observation([
            row({ index: 0, depth: 0, role: "AXWindow", AXIdentifier: undefined }),
            row({ index: 7 }),
        ]);
        const match = rematchElement({ chosen: row(), fresh });
        expect(match.row.index).toBe(7);
        expect(match.moved).toBe(false);
    });

    test("an element that has moved is re-resolved and flagged", () => {
        const fresh = observation([row({ index: 3, y: 400 })]);
        expect(rematchElement({ chosen: row(), fresh }).moved).toBe(true);
    });

    test("an element that is gone discards the decision", () => {
        const fresh = observation([row({ index: 0, AXIdentifier: "cancel-button", AXDescription: "Cancel" })]);
        expect(() => rematchElement({ chosen: row(), fresh })).toThrow(/no longer on screen/);
    });

    test("two identical candidates far apart are ambiguous, not a coin flip", () => {
        const fresh = observation([
            row({ index: 1, AXIdentifier: undefined, y: 66 }),
            row({ index: 2, AXIdentifier: undefined, y: 500 }),
        ]);
        expect(() => rematchElement({ chosen: row({ AXIdentifier: undefined, y: 300 }), fresh })).toThrow(/ambiguous/);
    });
});

describe("the probe budget", () => {
    test("a sweep inside the budget is untouched", () => {
        const points = Array.from({ length: 10 }, (_, index) => index);
        expect(withinBudget(points, 10)).toEqual(points);
        expect(withinBudget(points, 99)).toEqual(points);
    });

    test("an over-budget sweep is thinned across the whole screen, never cut to its top", () => {
        const screen = { x: 0, y: 0, width: 402, height: 874 };
        const planned = probePoints(screen, 20);
        expect(planned.length).toBeGreaterThan(400);

        const kept = withinBudget(planned, 400);
        expect(kept.length).toBeLessThanOrEqual(400);

        // The failure this replaced: a prefix stopped partway down, so the bottom of every screen
        // was invisible and a FINER step found FEWER elements than a coarse one.
        const lowest = Math.max(...kept.map(([, y]) => y));
        const plannedLowest = Math.max(...planned.map(([, y]) => y));
        expect(lowest).toBe(plannedLowest);

        const highest = Math.min(...kept.map(([, y]) => y));
        expect(highest).toBe(Math.min(...planned.map(([, y]) => y)));
    });

    test("thinning keeps points in order and never invents one", () => {
        const planned = probePoints({ x: 0, y: 0, width: 200, height: 200 }, 10);
        const kept = withinBudget(planned, 7);
        expect(kept.length).toBeLessThanOrEqual(7);
        for (const point of kept) {
            expect(planned).toContainEqual(point);
        }

        const indexes = kept.map((point) => planned.findIndex((p) => p[0] === point[0] && p[1] === point[1]));
        expect([...indexes].sort((a, b) => a - b)).toEqual(indexes);
    });
});
