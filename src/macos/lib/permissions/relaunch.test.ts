import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    argvFromPs,
    parseFrontmostPid,
    readFaceRecords,
    relaunchPlan,
    type WindowFace,
    windowFaceKind,
    windowFacesFromPs,
} from "./relaunch";

const LAUNCHER = "/Users/alice/Applications/GenesisTools.app/Contents/MacOS/GenesisTools";

describe("windowFaceKind", () => {
    it("keeps the hub, review and settings windows", () => {
        expect(windowFaceKind([])).toBe("settings");
        expect(windowFaceKind(["--window"])).toBe("settings");
        expect(windowFaceKind(["-psn_0_12345"])).toBe("settings");
        expect(windowFaceKind(["--hub", "--session", "abc"])).toBe("hub");
        expect(windowFaceKind(["--review", "--proposal", "/x/p.json"])).toBe("review");
    });

    it("skips short-lived faces, link routers and scripted runs", () => {
        expect(windowFaceKind(["--rpc", "{}"])).toBeNull();
        expect(windowFaceKind(["--notify"])).toBeNull();
        expect(windowFaceKind(["https://example.org/"])).toBeNull();
        expect(windowFaceKind(["--review", "--repo", "/x", "--snapshot", "/tmp/a.png"])).toBeNull();
        expect(windowFaceKind(["--hub", "--bench", "/tmp/b.json"])).toBeNull();
    });
});

describe("argvFromPs", () => {
    it("joins the words after a flag back into one value", () => {
        expect(argvFromPs("--review --repo /x/My Repo --scope branch")).toEqual([
            "--review",
            "--repo",
            "/x/My Repo",
            "--scope",
            "branch",
        ]);
    });

    it("keeps boolean flags apart", () => {
        expect(argvFromPs("--hub --no-activate --session s1")).toEqual(["--hub", "--no-activate", "--session", "s1"]);
        expect(argvFromPs("")).toEqual([]);
    });
});

describe("windowFacesFromPs", () => {
    const ps = [
        `  101 ${LAUNCHER} --review --proposal /Users/alice/.genesis-tools/review/proposals/my file.json`,
        `  102 ${LAUNCHER} --hub --session s1`,
        `  103 ${LAUNCHER} --rpc {}`,
        `  104 ${LAUNCHER}`,
        `  105 ${LAUNCHER} /usr/bin/env bun dev`,
        `  106 /bin/zsh -c something`,
    ].join("\n");

    it("takes the argv from a record that still spells the ps line", () => {
        const records = new Map([
            [101, ["--review", "--proposal", "/Users/alice/.genesis-tools/review/proposals/my file.json"]],
        ]);
        const faces = windowFacesFromPs({
            psStdout: ps,
            launcherPath: LAUNCHER,
            stalePids: new Set(["101", "102", "103", "104"]),
            records,
        });
        expect(faces).toEqual([
            {
                pid: 101,
                kind: "review",
                argv: ["--review", "--proposal", "/Users/alice/.genesis-tools/review/proposals/my file.json"],
                lossless: true,
            },
            { pid: 102, kind: "hub", argv: ["--hub", "--session", "s1"], lossless: false },
            { pid: 104, kind: "settings", argv: [], lossless: false },
        ]);
    });

    it("ignores a record of a reused pid and the pids the reap leaves alone", () => {
        const faces = windowFacesFromPs({
            psStdout: ps,
            launcherPath: LAUNCHER,
            stalePids: new Set(["102"]),
            records: new Map([[102, ["--review", "--repo", "/elsewhere"]]]),
        });
        expect(faces).toEqual([{ pid: 102, kind: "hub", argv: ["--hub", "--session", "s1"], lossless: false }]);
    });
});

describe("relaunchPlan", () => {
    const faces: WindowFace[] = [
        { pid: 1, kind: "review", argv: ["--review", "--repo", "/x", "--no-activate"], lossless: true },
        { pid: 2, kind: "hub", argv: ["--hub", "--session", "s1", "--resume"], lossless: true },
        { pid: 3, kind: "settings", argv: [], lossless: false },
    ];

    it("activates only the frontmost face, and starts it last", () => {
        expect(relaunchPlan(faces, 1)).toEqual([
            { pid: 2, kind: "hub", argv: ["--hub", "--session", "s1", "--resume", "--no-activate"], activate: false },
            { pid: 3, kind: "settings", argv: ["--window", "--no-activate"], activate: false },
            { pid: 1, kind: "review", argv: ["--review", "--repo", "/x"], activate: true },
        ]);
    });

    it("opens everything behind when no face was in front", () => {
        const plan = relaunchPlan(faces, 999);
        expect(plan.every((step) => !step.activate && step.argv.at(-1) === "--no-activate")).toBe(true);
    });
});

describe("parseFrontmostPid", () => {
    it("reads lsappinfo's pid line", () => {
        expect(parseFrontmostPid('"pid"=55670\n')).toBe(55670);
        expect(parseFrontmostPid("")).toBeNull();
    });
});

describe("readFaceRecords", () => {
    it("reads valid records and skips broken ones", () => {
        const dir = mkdtempSync(join(tmpdir(), "faces-"));
        writeFileSync(join(dir, "11.json"), '{"pid":11,"argv":["--hub","--session","a b"]}');
        writeFileSync(join(dir, "12.json"), "{not json");
        writeFileSync(join(dir, "13.json"), '{"pid":13,"argv":[1]}');
        expect([...readFaceRecords(dir)]).toEqual([[11, ["--hub", "--session", "a b"]]]);
    });
});
