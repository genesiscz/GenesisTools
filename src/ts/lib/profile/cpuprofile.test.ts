import { describe, expect, it } from "bun:test";
import { asCpuProfile, type CpuProfile, focusTree, summarizeProfiles } from "./cpuprofile";

const REPO = "/work/repo";

function frame(functionName: string, url: string, lineNumber = 0) {
    return { functionName, url, lineNumber, columnNumber: 0 };
}

// (root) -> main (repo) -> listRows (repo) -> parse (native)
//                       -> recurse (repo) -> recurse (repo)
//        -> (garbage collector)
const profile: CpuProfile = {
    startTime: 0,
    endTime: 10_000,
    nodes: [
        { id: 1, callFrame: frame("(root)", ""), children: [2, 6] },
        { id: 2, callFrame: frame("main", `${REPO}/src/main.ts`, 9), children: [3, 5] },
        { id: 3, callFrame: frame("listRows", `${REPO}/src/rows.ts`, 41), children: [4] },
        { id: 4, callFrame: frame("parse", "") },
        { id: 5, callFrame: frame("recurse", `${REPO}/src/walk.ts`, 2), children: [7] },
        { id: 6, callFrame: frame("(garbage collector)", "") },
        { id: 7, callFrame: frame("recurse", `${REPO}/src/walk.ts`, 2) },
    ],
    // parse, parse, listRows, recurse(inner), gc, parse
    samples: [4, 4, 3, 7, 6, 4],
    timeDeltas: [0, 1000, 1000, 1000, 1000, 1000],
};

describe("summarizeProfiles", () => {
    const summary = summarizeProfiles([profile], REPO);
    const fn = (name: string) => summary.functions.find((cost) => cost.fn.name === name);
    const repoFn = (name: string) => summary.repoFunctions.find((cost) => cost.fn.name === name);

    it("weights each sample by the gap to the next one and drops profiler pseudo-frames", () => {
        expect(summary.samples).toBe(5);
        expect(summary.sampledUs).toBe(5000);
        expect(fn("(garbage collector)")).toBeUndefined();
    });

    it("counts self time at the leaf and total time once per sample even under recursion", () => {
        expect(fn("parse")).toMatchObject({ selfUs: 3000, totalUs: 3000 });
        expect(fn("recurse")).toMatchObject({ selfUs: 1000, totalUs: 1000 });
        expect(fn("main")).toMatchObject({ selfUs: 0, totalUs: 5000 });
        expect(fn("main")?.fn.location).toBe("src/main.ts:10");
        expect(fn("parse")?.fn.location).toBe("[native]");
    });

    it("charges native time to the deepest repository frame and builds a repository call tree", () => {
        expect(repoFn("listRows")).toMatchObject({ selfUs: 4000, totalUs: 4000 });
        expect(repoFn("main")).toMatchObject({ selfUs: 0, totalUs: 5000 });
        expect(summary.repoTree.map((node) => [node.fn.name, node.totalUs])).toEqual([["main", 5000]]);
        expect(summary.repoTree[0].children.map((node) => [node.fn.name, node.totalUs])).toEqual([
            ["listRows", 4000],
            ["recurse", 1000],
        ]);
        expect(focusTree(summary.repoTree, "recurse").map((node) => node.fn.name)).toEqual(["recurse"]);
    });
});

describe("await gaps", () => {
    it("counts a long gap as one interval of work and reports the rest as waiting", () => {
        const waiting: CpuProfile = {
            startTime: 0,
            endTime: 0,
            nodes: [
                { id: 1, callFrame: frame("(root)", ""), children: [2] },
                { id: 2, callFrame: frame("work", `${REPO}/src/work.ts`), children: [] },
            ],
            samples: [2, 2, 2, 2, 2],
            timeDeltas: [0, 1000, 1000, 500_000, 1000],
        };
        const summary = summarizeProfiles([waiting], REPO);

        expect(summary.functions[0]).toMatchObject({ selfUs: 5000 });
        expect(summary.idleUs).toBe(499_000);
    });
});

describe("asCpuProfile", () => {
    it("accepts a profile and refuses other JSON", () => {
        expect(asCpuProfile(profile)).not.toBeNull();
        expect(asCpuProfile({ nodes: [], samples: [1], timeDeltas: "x", startTime: 0, endTime: 1 })).toBeNull();
        expect(asCpuProfile(null)).toBeNull();
    });
});
