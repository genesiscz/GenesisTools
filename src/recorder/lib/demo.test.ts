import { describe, expect, test } from "bun:test";
import type { EditOp } from "@genesiscz/utils/recording-editor/project";
import { type DemoDriver, demoEditOps, demoScriptSchema, runDemo, subtractRanges } from "./demo";

const steps = [
    { caption: "Open the settings", startMs: 2000, runEndMs: 3000, endMs: 4000 },
    { caption: "Turn on dark mode", startMs: 9000, runEndMs: 9500, endMs: 10_500 },
    { caption: "Done", startMs: 11_000, runEndMs: 11_000, endMs: 12_000 },
];

describe("demoEditOps", () => {
    test("cuts the lead-in, each long wait between steps, and the tail; adds a caption per step", () => {
        const ops = demoEditOps({ steps, durationMs: 20_000 });
        expect(ops.filter((op) => op.op === "cut")).toEqual([
            { op: "cut", from: 0, to: 1.5 },
            { op: "cut", from: 4.3, to: 8.7 },
            { op: "cut", from: 13, to: 20 },
        ]);
        expect(ops.filter((op) => op.op === "text")).toEqual([
            { op: "text", from: 2, to: 4, text: "Open the settings", y: 0.88 },
            { op: "text", from: 9, to: 10.8, text: "Turn on dark mode", y: 0.88 },
            { op: "text", from: 11, to: 12.8, text: "Done", y: 0.88 },
        ]);
    });

    test("keeps a short wait and puts captions on top", () => {
        const ops = demoEditOps({
            steps,
            durationMs: 13_000,
            edit: { minWaitSeconds: 1, captionPosition: "top", leadSeconds: 5 },
        });
        // The 0.5 s between step 2 and 3 stays; nothing before step 1 is cut with a 5 s lead.
        expect(ops.filter((op) => op.op === "cut").map((op) => [op.from, op.to])).toEqual([[4.3, 8.7]]);
        expect(ops.find((op) => op.op === "text")).toMatchObject({ y: 0.1 });
    });

    test("cuts the still waiting while a step's code runs, never its first moments or its hold", () => {
        const long = [{ caption: "Load the page", startMs: 1000, runEndMs: 9000, endMs: 10_000 }];
        // Still from 0.5 s to 10 s: the page loads behind a spinner, then the result stays still in the hold.
        const ops = demoEditOps({
            steps: long,
            durationMs: 10_000,
            idleMs: [[500, 10_000]],
            edit: { captions: false },
        });
        // The 0.5 s before the step is shorter than the 0.8 s a cut wait needs, so it stays.
        expect(ops).toEqual([{ op: "cut", from: 1.3, to: 8.7 }]);
        expect(
            demoEditOps({
                steps: long,
                durationMs: 10_000,
                idleMs: [[500, 10_000]],
                edit: { captions: false, cutIdle: false },
            })
        ).toEqual([]);
    });

    test("no steps or no movie give no ops; captions and cuts can be turned off", () => {
        expect(demoEditOps({ steps: [], durationMs: 5000 })).toEqual([]);
        expect(demoEditOps({ steps, durationMs: 0 })).toEqual([]);
        expect(
            demoEditOps({ steps, durationMs: 20_000, edit: { cutWaits: false, captions: false, cutIdle: false } })
        ).toEqual([]);
    });
});

function fakeDriver() {
    let clock = 0;
    const marks: string[] = [];
    const edits: EditOp[][] = [];
    let stopped = false;
    const driver: DemoDriver = {
        async start() {
            return {
                async mark(label: string) {
                    marks.push(label);
                    return { atMs: clock };
                },
                async stop() {
                    stopped = true;
                    return "/library/video-demo";
                },
            };
        },
        async durationMs() {
            return clock + 500;
        },
        async idleMs() {
            return [];
        },
        async edit(_folder, ops) {
            edits.push(ops);
        },
        async exportMovie(folder) {
            return { path: `${folder}/demo.mp4`, outputSeconds: 4 };
        },
        async sleep(ms) {
            clock += ms;
        },
        now: () => clock,
    };
    return { driver, marks, edits, isStopped: () => stopped, advance: (ms: number) => (clock += ms) };
}

test("subtractRanges keeps what lies outside the kept parts", () => {
    expect(
        subtractRanges(
            [[0, 10]],
            [
                [2, 3],
                [5, 12],
            ]
        )
    ).toEqual([
        [0, 2],
        [3, 5],
    ]);
    expect(subtractRanges([[0, 1]], [[1, 2]])).toEqual([[0, 1]]);
});

describe("runDemo", () => {
    test("marks each step, times it with its hold, edits the movie and exports it", async () => {
        const fake = fakeDriver();
        const result = await runDemo({
            driver: fake.driver,
            settleSeconds: 1,
            steps: [
                { caption: "Open the settings", run: () => fake.advance(2000), holdSeconds: 0.5 },
                { caption: "Wait for the page", run: () => fake.advance(6000) },
            ],
        });
        expect(fake.marks).toEqual(["Open the settings", "Wait for the page"]);
        expect(result.steps).toEqual([
            { caption: "Open the settings", startMs: 1000, runEndMs: 3000, endMs: 3500 },
            { caption: "Wait for the page", startMs: 3500, runEndMs: 9500, endMs: 10_500 },
        ]);
        expect(result.exported).toEqual({ path: "/library/video-demo/demo.mp4", outputSeconds: 4 });
        expect(fake.edits).toHaveLength(1);
        expect(fake.edits[0].filter((op) => op.op === "text")).toHaveLength(2);
        expect(result.failed).toEqual([]);
    });

    test("a step that throws is noted, the next one runs and the recording still stops", async () => {
        const fake = fakeDriver();
        const result = await runDemo({
            driver: fake.driver,
            export: false,
            steps: [
                {
                    caption: "Broken",
                    run: () => {
                        throw new Error("no such button");
                    },
                },
                { caption: "Next", run: () => fake.advance(100) },
            ],
        });
        expect(result.failed).toEqual([{ caption: "Broken", error: "no such button" }]);
        expect(result.steps.map((step) => step.caption)).toEqual(["Broken", "Next"]);
        expect(result.exported).toBeUndefined();
        expect(fake.isStopped()).toBe(true);
    });

    test("refuses a demo without steps", async () => {
        await expect(runDemo({ driver: fakeDriver().driver, steps: [] })).rejects.toThrow("at least one step");
    });
});

describe("demo script (the JSON door)", () => {
    test("takes tools, shell and wait steps with defaults, and names a step without a caption", () => {
        const script = demoScriptSchema.parse({
            steps: [
                { caption: "Reload", tools: ["control", "key", "cmd+r"] },
                { caption: "Read", wait: 2 },
            ],
        });
        expect(script.record).toEqual({});
        expect(script.steps[0].tools).toEqual(["control", "key", "cmd+r"]);
        expect(demoScriptSchema.safeParse({ steps: [{ shell: "true" }] }).success).toBe(false);
        expect(demoScriptSchema.safeParse({ steps: [] }).success).toBe(false);
    });
});
