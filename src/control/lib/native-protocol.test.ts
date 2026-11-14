import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { fakeAx } from "./__fixtures__/fake-ax";
import { ComputerUse } from "./computer-use/session";
import type { ActionParameters, ControlAction } from "./decision/action";
import { NativeControlDriver } from "./decision/native";
import { candidatesFor, type ObservedElement } from "./decision/observation";
import {
    actArguments,
    nativeActionArguments,
    PREPARABLE_ACTIONS,
    parseObservation,
    pinArguments,
    seeArguments,
    TARGET_KEY_ACTIONS,
    webActivationKey,
    webDispatchArguments,
} from "./native-protocol";
import type { AxResult } from "./runner";

const key = (c: string) => c.repeat(64);
const twinStable = "12".repeat(32);
const twinTarget = "34".repeat(32);
const webFieldTarget = "ab".repeat(32);
const geometry = { x: 10, y: 10, width: 20, height: 20 };

/** One recorded `see` answer, the shape ax-tool prints; every row below names its index in it. */
function recordedSee() {
    return {
        ok: true,
        app: "Fixture",
        pid: 7,
        processLaunch: 123,
        scope: "window",
        snapshot: "s0",
        window: { id: 10, title: "Fixture", x: 0, y: 0, width: 400, height: 300 },
        screenshot: { path: "/fixture.png", width: 400, height: 300 },
        elements: [
            {
                index: 0,
                depth: 0,
                role: "AXWindow",
                AXTitle: "Fixture",
                AXFocused: true,
                stableKey: key("0"),
                targetKey: key("1"),
                ...geometry,
            },
            {
                index: 1,
                depth: 1,
                role: "AXButton",
                AXTitle: "Save",
                actions: ["AXPress"],
                stableKey: key("2"),
                targetKey: key("3"),
                ...geometry,
            },
            {
                index: 2,
                depth: 1,
                role: "AXTextField",
                AXTitle: "Name",
                AXValue: "old",
                valueSettable: true,
                AXFocused: false,
                stableKey: key("4"),
                targetKey: key("5"),
                ...geometry,
            },
            {
                index: 3,
                depth: 1,
                role: "AXButton",
                AXTitle: "OnlyTarget",
                actions: ["AXPress"],
                targetKey: key("6"),
                ...geometry,
            },
            {
                index: 4,
                depth: 1,
                role: "AXMenuButton",
                AXTitle: "More",
                actions: ["AXShowMenu"],
                stableKey: key("7"),
                targetKey: key("8"),
                ...geometry,
            },
            { index: 5, depth: 1, role: "AXWebArea", AXURL: "https://example.com/", ...geometry },
            {
                index: 6,
                depth: 2,
                role: "AXLink",
                AXTitle: "Docs",
                actions: ["AXPress"],
                stableKey: key("b"),
                targetKey: key("c"),
                ...geometry,
            },
            {
                index: 7,
                depth: 2,
                role: "AXButton",
                AXTitle: "Continue",
                actions: ["AXPress"],
                stableKey: key("d"),
                targetKey: key("e"),
                ...geometry,
            },
            {
                index: 8,
                depth: 2,
                role: "AXTextArea",
                AXTitle: "Notes",
                AXValue: "old",
                valueSettable: true,
                stableKey: key("f"),
                targetKey: webFieldTarget,
                ...geometry,
            },
            {
                index: 9,
                depth: 1,
                role: "AXButton",
                AXTitle: "Twin",
                actions: ["AXPress"],
                stableKey: twinStable,
                targetKey: twinTarget,
                ...geometry,
            },
            {
                index: 10,
                depth: 1,
                role: "AXButton",
                AXTitle: "Twin",
                actions: ["AXPress"],
                stableKey: twinStable,
                targetKey: twinTarget,
                ...geometry,
            },
        ],
    };
}

function observedRows(): ObservedElement[] {
    const parsed = parseObservation(recordedSee());
    if (!parsed.success) {
        throw parsed.error;
    }

    return parsed.data.elements;
}

function row(index: number): ObservedElement {
    const found = observedRows().find((element) => element.index === index);
    if (!found) {
        throw new Error(`no row ${index} in the recorded see`);
    }

    return found;
}

/** The one fake runner every row goes through: it answers `see` with the recording and records each argv. */
function recordedRunner() {
    const fake = fakeAx((args) => (args[0] === "see" ? recordedSee() : { ok: true, after: recordedSee() }));
    return {
        calls: fake.calls,
        run: async ({ args }: { args: string[] }): Promise<AxResult> => fake.run(args),
        last: (verb: string) => fake.calls.filter((args) => args[0] === verb).at(-1),
    };
}

describe("the allowlists mirror ax-tool's WorkflowArguments.validateAction", () => {
    const swift = readFileSync(
        join(import.meta.dir, "../../../native/ax-tool/SnapshotSupport/WorkflowArguments.swift"),
        "utf8"
    );
    const swiftList = (option: string): string[] => {
        const match = new RegExp(`reject\\(\\["${option}"\\], unless: \\[([^\\]]*)\\]\\)`).exec(swift);
        if (!match) {
            throw new Error(`WorkflowArguments.swift has no reject(["${option}"], unless: [...]) line any more`);
        }

        return match[1].split(",").map((item) => item.trim().replace(/^"|"$/g, ""));
    };

    test("--target-key", () => {
        expect<string[]>([...TARGET_KEY_ACTIONS]).toEqual(swiftList("--target-key"));
    });

    test("--prepare", () => {
        expect<string[]>([...PREPARABLE_ACTIONS]).toEqual(swiftList("--prepare"));
    });
});

describe("see argv", () => {
    const cases: Array<[string, Parameters<typeof seeArguments>[0], string[]]> = [
        ["defaults to the window scope", { app: "Fixture" }, ["see", "--app", "Fixture", "--scope", "window"]],
        [
            "a query carries its text and role",
            { app: "Fixture", scope: "query", query: { text: "Save", role: "AXButton" }, depth: 50, image: false },
            [
                "see",
                "--app",
                "Fixture",
                "--scope",
                "query",
                "--query",
                "Save",
                "--query-role",
                "AXButton",
                "--depth",
                "50",
                "--no-image",
            ],
        ],
        [
            "OCR reuse, a window id over an index, and the screenshot path",
            {
                app: "Fixture",
                perception: "ocr",
                perceptionReuse: "/tmp/ocr.json",
                windowId: 4,
                windowIndex: 2,
                path: "/tmp/shot.png",
            },
            [
                "see",
                "--app",
                "Fixture",
                "--scope",
                "window",
                "--perception",
                "ocr",
                "--perception-reuse",
                "/tmp/ocr.json",
                "--window-id",
                "4",
                "--path",
                "/tmp/shot.png",
            ],
        ],
        [
            "a window index when no id is pinned",
            { app: "Fixture", scope: "chrome", windowIndex: 2 },
            ["see", "--app", "Fixture", "--scope", "chrome", "--window-index", "2"],
        ],
    ];

    for (const [name, request, argv] of cases) {
        test(name, () => {
            expect(seeArguments(request)).toEqual(argv);
        });
    }

    test("a query scope without its text is refused", () => {
        expect(() => seeArguments({ app: "Fixture", scope: "query" })).toThrow("needs the query text");
    });
});

describe("recorded output to a typed result", () => {
    test("a recorded see parses into an observation with every row", () => {
        const parsed = parseObservation(recordedSee());
        expect(parsed.success).toBe(true);
        expect(parsed.data?.window.id).toBe(10);
        expect(parsed.data?.elements.map((element) => element.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });

    test("a recorded refusal does not parse", () => {
        expect(parseObservation({ ok: false, error: "AX tree exceeds --depth 50" }).success).toBe(false);
    });
});

describe("act argv", () => {
    test("the envelope, with the element before the action", () => {
        expect(
            actArguments({ app: "Fixture", snapshot: "s0", element: 3, action: ["--action", "press"], image: false })
        ).toEqual([
            "act",
            "--app",
            "Fixture",
            "--snapshot",
            "s0",
            "--element",
            "3",
            "--action",
            "press",
            "--refresh",
            "--no-image",
        ]);
    });

    test("the envelope, with the caller's own element placement, foreground and screenshot path", () => {
        expect(
            actArguments({
                app: "Fixture",
                snapshot: "s0",
                action: ["--action", "press", "--element", "3"],
                allowForeground: true,
                path: "/tmp/shot.png",
            })
        ).toEqual([
            "act",
            "--app",
            "Fixture",
            "--snapshot",
            "s0",
            "--action",
            "press",
            "--element",
            "3",
            "--allow-foreground",
            "--refresh",
            "--path",
            "/tmp/shot.png",
        ]);
    });
});

describe("action parameters", () => {
    const cases: Array<[ControlAction, string | undefined, ActionParameters | undefined, string[] | RegExp]> = [
        ["press", undefined, undefined, ["--action", "press"]],
        [
            "click",
            undefined,
            { button: "right", count: 2, background: false },
            ["--action", "click", "--button", "right", "--double"],
        ],
        ["click", undefined, undefined, ["--action", "click", "--button", "left", "--background"]],
        [
            "scroll",
            undefined,
            { direction: "down", pixels: 50 },
            ["--action", "scroll", "--direction", "down", "--pixels", "50", "--background"],
        ],
        [
            "scroll",
            undefined,
            { direction: "up" },
            ["--action", "scroll", "--direction", "up", "--pages", "1", "--background"],
        ],
        ["hover", undefined, { dwell: 300 }, ["--action", "hover", "--dwell", "300"]],
        ["key", undefined, { keys: "cmd,a" }, ["--action", "key", "--keys", "cmd,a"]],
        ["perform", undefined, { axAction: "AXShowMenu" }, ["--action", "perform", "--ax-action", "AXShowMenu"]],
        ["set", "new", undefined, ["--action", "set", "--value", "new"]],
        ["type", "hi", undefined, ["--action", "type", "--text", "hi"]],
        ["paste", "x", { format: "md" }, ["--action", "paste", "--text", "x", "--format", "md"]],
        [
            "select",
            "ol",
            { selection: "cursor_after", prefix: "p" },
            ["--action", "select", "--text", "ol", "--selection", "cursor_after", "--prefix", "p"],
        ],
        ["press", undefined, { keys: "a" }, /Parameter keys is not valid for press/],
        ["set", undefined, undefined, /set requires an exact supplied value/],
        ["type", "two\nlines", undefined, /use paste/],
        ["focus", "x", undefined, /focus does not accept a supplied value/],
        ["scroll", undefined, { direction: "up", pages: 1, pixels: 5 }, /at most one of pages\/pixels/],
        ["perform", undefined, undefined, /perform requires parameters.axAction/],
    ];

    for (const [action, value, parameters, expected] of cases) {
        test(`${action} ${SafeJSON.stringify(parameters ?? {})}${value === undefined ? "" : " with a value"}`, () => {
            if (expected instanceof RegExp) {
                expect(() => nativeActionArguments({ action, value, parameters })).toThrow(expected);
                return;
            }

            expect(nativeActionArguments({ action, value, parameters })).toEqual(expected);
        });
    }
});

describe("the pin rule", () => {
    const rows = observedRows();
    const cases: Array<[string, { action: string; index: number; prepare: boolean }, string[]]> = [
        [
            "prepared: --prepare with the targetKey",
            { action: "click", index: 1, prepare: true },
            ["--prepare", "--target-key", key("3")],
        ],
        [
            "prepared twin: the targetKey ordinal",
            { action: "press", index: 9, prepare: true },
            ["--prepare", "--target-key", twinTarget, "--target-ordinal", "0/2"],
        ],
        [
            "unprepared: the stable key with element revalidation",
            { action: "press", index: 1, prepare: false },
            ["--target-key", key("2"), "--revalidate-scope", "element"],
        ],
        [
            "unprepared twin: the stable key ordinal",
            { action: "press", index: 10, prepare: false },
            ["--target-key", twinStable, "--revalidate-scope", "element", "--target-ordinal", "1/2"],
        ],
        [
            "a row with only a targetKey is pinned by it",
            { action: "press", index: 3, prepare: false },
            ["--target-key", key("6"), "--revalidate-scope", "element"],
        ],
        [
            "focus takes --target-key",
            { action: "focus", index: 2, prepare: false },
            ["--target-key", key("4"), "--revalidate-scope", "element"],
        ],
        [
            "prepared drag focuses and pins its source",
            { action: "drag", index: 0, prepare: true },
            ["--prepare", "--target-key", key("1")],
        ],
        [
            "drag takes --target-key",
            { action: "drag", index: 0, prepare: false },
            ["--target-key", key("0"), "--revalidate-scope", "element"],
        ],
        [
            "perform is never prepared, but is pinned",
            { action: "perform", index: 4, prepare: true },
            ["--target-key", key("7"), "--revalidate-scope", "element"],
        ],
        ["an action outside both allowlists gets nothing", { action: "launch", index: 1, prepare: true }, []],
        ["a row without keys gets a bare --prepare", { action: "click", index: 5, prepare: true }, ["--prepare"]],
        ["a row without keys gets no unprepared pin", { action: "click", index: 5, prepare: false }, []],
    ];

    for (const [name, input, argv] of cases) {
        test(name, () => {
            expect(pinArguments({ action: input.action, row: row(input.index), rows, prepare: input.prepare })).toEqual(
                argv
            );
        });
    }

    test("no row, no pin", () => {
        expect(pinArguments({ action: "scroll", row: undefined, rows, prepare: false })).toEqual([]);
    });
});

describe("web activation", () => {
    const rows = observedRows();

    test("a page link takes return, a page button space, anything outside a page nothing", () => {
        expect(webActivationKey(rows, row(6))).toBe("return");
        expect(webActivationKey(rows, row(7))).toBe("space");
        expect(webActivationKey(rows, row(1))).toBeUndefined();
    });

    test("set on a page text field becomes a replacing paste, and a native field keeps set", () => {
        expect(webDispatchArguments({ action: "set", row: row(8), rows, value: "new" })).toEqual([
            "--action",
            "paste",
            "--text",
            "new",
            "--format",
            "text",
            "--replace",
        ]);
        expect(webDispatchArguments({ action: "set", row: row(2), rows, value: "new" })).toBeUndefined();
        expect(webDispatchArguments({ action: "press", row: row(6), rows })).toEqual([
            "--action",
            "key",
            "--keys",
            "return",
        ]);
    });
});

const oldDigest = createHash("sha256").update("old", "utf8").digest("hex");

describe("the decision driver: (observation row, action, parameters) to argv", () => {
    const cases: Array<{
        name: string;
        index: number;
        action: ControlAction;
        value?: string;
        parameters?: ActionParameters;
        prepare?: boolean | "auto";
        image?: boolean;
        argv: string[];
    }> = [
        {
            name: "an unprepared press pins the stable key",
            index: 1,
            action: "press",
            argv: ["--action", "press", "--target-key", key("2"), "--revalidate-scope", "element"],
        },
        {
            name: "focus is pinned (it was the one action the old list missed)",
            index: 2,
            action: "focus",
            argv: ["--action", "focus", "--target-key", key("4"), "--revalidate-scope", "element"],
        },
        {
            name: "a press rewritten to perform is pinned, never prepared",
            index: 4,
            action: "press",
            prepare: true,
            argv: [
                "--action",
                "perform",
                "--ax-action",
                "AXShowMenu",
                "--target-key",
                key("7"),
                "--revalidate-scope",
                "element",
            ],
        },
        {
            name: "a prepared page link presses return",
            index: 6,
            action: "press",
            prepare: "auto",
            argv: ["--action", "key", "--keys", "return", "--prepare", "--target-key", key("c")],
        },
        {
            name: "a prepared page button presses space",
            index: 7,
            action: "press",
            prepare: true,
            argv: ["--action", "key", "--keys", "space", "--prepare", "--target-key", key("e")],
        },
        {
            name: "a prepared set on a page field pastes",
            index: 8,
            action: "set",
            value: "new",
            prepare: true,
            argv: [
                "--action",
                "paste",
                "--text",
                "new",
                "--format",
                "text",
                "--replace",
                "--prepare",
                "--target-key",
                webFieldTarget,
            ],
        },
        {
            name: "a key into a text field carries the observed value digest",
            index: 2,
            action: "key",
            parameters: { keys: "return" },
            argv: [
                "--action",
                "key",
                "--keys",
                "return",
                "--expect-value-sha256",
                oldDigest,
                "--target-key",
                key("4"),
                "--revalidate-scope",
                "element",
            ],
        },
        {
            name: "an unprepared twin carries its ordinal",
            index: 10,
            action: "press",
            argv: [
                "--action",
                "press",
                "--target-key",
                twinStable,
                "--revalidate-scope",
                "element",
                "--target-ordinal",
                "1/2",
            ],
        },
        {
            name: "a scroll is pinned and in the background",
            index: 1,
            action: "scroll",
            parameters: { direction: "down", pixels: 50 },
            argv: [
                "--action",
                "scroll",
                "--direction",
                "down",
                "--pixels",
                "50",
                "--background",
                "--target-key",
                key("2"),
                "--revalidate-scope",
                "element",
            ],
        },
    ];

    for (const item of cases) {
        test(item.name, async () => {
            const runner = recordedRunner();
            const driver = new NativeControlDriver({
                app: "Fixture",
                prepare: item.prepare,
                image: item.image,
                run: runner.run,
            });
            const observation = await driver.observe({});
            const candidate = candidatesFor({ observation, action: item.action, parameters: item.parameters }).find(
                (entry) => entry.element === item.index
            );
            if (!candidate) {
                throw new Error(`no ${item.action} candidate for row ${item.index}`);
            }

            await driver.act({ observation, candidate, value: item.value, parameters: item.parameters });
            expect(runner.last("act")).toEqual([
                "act",
                "--app",
                "Fixture",
                "--snapshot",
                "s0",
                "--element",
                String(item.index),
                ...item.argv,
                "--refresh",
            ]);
        });
    }

    const seeCases: Array<[string, ConstructorParameters<typeof NativeControlDriver>[0], string[]]> = [
        ["see defaults", { app: "Fixture" }, ["see", "--app", "Fixture", "--scope", "window"]],
        [
            "see with a depth, a window index and no image",
            { app: "Fixture", depth: 20, windowIndex: 2, image: false },
            ["see", "--app", "Fixture", "--scope", "window", "--depth", "20", "--no-image", "--window-index", "2"],
        ],
        [
            "a perception cache turns OCR on with reuse",
            { app: "Fixture", perceptionReuse: "/tmp/session/ocr.json" },
            [
                "see",
                "--app",
                "Fixture",
                "--scope",
                "window",
                "--perception",
                "ocr",
                "--perception-reuse",
                "/tmp/session/ocr.json",
            ],
        ],
    ];

    for (const [name, options, argv] of seeCases) {
        test(name, async () => {
            const runner = recordedRunner();
            const observation = await new NativeControlDriver({ ...options, run: runner.run }).observe({});
            expect(runner.last("see")).toEqual(argv);
            expect(observation.elements).toHaveLength(11);
        });
    }
});

describe("ComputerUse: (verb, observation row, parameters) to argv", () => {
    const envelope = (action: string[]) => [
        "act",
        "--app",
        "Fixture",
        "--snapshot",
        "s0",
        ...action,
        "--refresh",
        "--no-image",
    ];
    const cases: Array<[string, (computer: ComputerUse, revision: string) => Promise<unknown>, string[]]> = [
        [
            "an unprepared AXPress click pins its row by the stable key",
            (computer, revision) => computer.click({ app: "Fixture", revision, element_index: 1 }),
            ["--action", "press", "--element", "1", "--target-key", key("2"), "--revalidate-scope", "element"],
        ],
        [
            "a prepared page button presses space in front",
            (computer, revision) => computer.click({ app: "Fixture", revision, element_index: 7, prepare: true }),
            ["--action", "key", "--element", "7", "--keys", "space", "--prepare", "--target-key", key("e")],
        ],
        [
            "a prepared set on a page field pastes with replace",
            (computer, revision) =>
                computer.set_value({ app: "Fixture", revision, element_index: 8, value: "new", prepare: true }),
            [
                "--action",
                "paste",
                "--element",
                "8",
                "--text",
                "new",
                "--format",
                "text",
                "--replace",
                "--prepare",
                "--target-key",
                webFieldTarget,
            ],
        ],
        [
            "a prepared set on a native field keeps set",
            (computer, revision) =>
                computer.set_value({ app: "Fixture", revision, element_index: 2, value: "native", prepare: true }),
            ["--action", "set", "--element", "2", "--value", "native", "--prepare", "--target-key", key("5")],
        ],
        [
            "one of two identical buttons carries its position",
            (computer, revision) => computer.click({ app: "Fixture", revision, element_index: 10 }),
            [
                "--action",
                "press",
                "--element",
                "10",
                "--target-key",
                twinStable,
                "--revalidate-scope",
                "element",
                "--target-ordinal",
                "1/2",
            ],
        ],
        [
            "a right click never prepares, even when asked",
            (computer, revision) =>
                computer.click({ app: "Fixture", revision, element_index: 1, mouse_button: "right", prepare: true }),
            [
                "--action",
                "click",
                "--element",
                "1",
                "--button",
                "right",
                "--background",
                "--target-key",
                key("2"),
                "--revalidate-scope",
                "element",
            ],
        ],
        [
            "focus is pinned",
            (computer, revision) => computer.focus({ app: "Fixture", revision, element_index: 2 }),
            ["--action", "focus", "--element", "2", "--target-key", key("4"), "--revalidate-scope", "element"],
        ],
    ];

    for (const [name, call, action] of cases) {
        test(name, async () => {
            const runner = recordedRunner();
            const computer = new ComputerUse({ native: runner });
            const state = await computer.get_app_state({ app: "Fixture", image: false });
            await call(computer, state.revision);
            expect(runner.last("act")).toEqual(envelope(action));
        });
    }

    test("observation argv for a window and for a query", async () => {
        const runner = recordedRunner();
        const computer = new ComputerUse({ native: runner });
        await computer.get_app_state({ app: "Fixture", image: false });
        expect(runner.last("see")).toEqual([
            "see",
            "--app",
            "Fixture",
            "--scope",
            "window",
            "--depth",
            "50",
            "--no-image",
        ]);
        await computer
            .get_app_state({ app: "Fixture", image: false, query: "Save", role: "AXButton" })
            .catch(() => undefined);
        expect(runner.last("see")).toEqual([
            "see",
            "--app",
            "Fixture",
            "--scope",
            "query",
            "--query",
            "Save",
            "--query-role",
            "AXButton",
            "--depth",
            "50",
            "--no-image",
            "--window-id",
            "10",
        ]);
    });
});
