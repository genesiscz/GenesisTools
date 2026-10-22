function processRows(text: string): Array<{ pid: number; command: string }> {
    return text.split("\n").flatMap((line) => {
        const match = line.trim().match(/^(\d+)\s+(.*)$/);
        return match ? [{ pid: Number(match[1]), command: match[2] }] : [];
    });
}

import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    argvFromPs,
    linkRelayOpenArgs,
    parseFrontmostPid,
    planRelaunch,
    readFaceFrontWindows,
    readFaceRecords,
    readFaceWindows,
    relaunchCommands,
    relaunchPlan,
    type WindowFace,
    windowFaceKind,
    windowFacesFromPs,
    withoutHubActions,
} from "./relaunch";

const LAUNCHER = "/Users/alice/Applications/GenesisTools.app/Contents/MacOS/GenesisTools";

describe("windowFaceKind", () => {
    it("keeps the settings window, the hub, a review, the widget and the feature settings", () => {
        expect(windowFaceKind([])).toBe("settings");
        expect(windowFaceKind(["--window"])).toBe("settings");
        expect(windowFaceKind(["-psn_0_12345"])).toBe("settings");
        expect(windowFaceKind(["--hub", "--session", "abc"])).toBe("hub");
        expect(windowFaceKind(["--review", "--proposal", "/x/p.json"])).toBe("review");
        expect(windowFaceKind(["--widget", "--ensure-running"])).toBe("widget");
        expect(windowFaceKind(["--features", "--page", "general"])).toBe("features");
        // The face's old name, as a face started by an older build carries it.
        expect(windowFaceKind(["--clicky", "--page", "general"])).toBe("features");
    });

    it("skips short-lived faces, link routers and scripted runs", () => {
        expect(windowFaceKind(["--rpc", "{}"])).toBeNull();
        expect(windowFaceKind(["--notify"])).toBeNull();
        expect(windowFaceKind(["https://example.org/"])).toBeNull();
        expect(windowFaceKind(["--review", "--repo", "/x", "--snapshot", "/tmp/a.png"])).toBeNull();
        expect(windowFaceKind(["--hub", "--bench", "/tmp/b.json"])).toBeNull();
        expect(windowFaceKind(["--clicky", "--page", "general", "--headless"])).toBeNull();
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
            processes: processRows(ps),
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
            processes: processRows(ps),
            launcherPath: LAUNCHER,
            stalePids: new Set(["102"]),
            records: new Map([[102, ["--review", "--repo", "/elsewhere"]]]),
        });
        expect(faces).toEqual([{ pid: 102, kind: "hub", argv: ["--hub", "--session", "s1"], lossless: false }]);
    });
    it("brings back every window of the one review process", () => {
        const proposal = "/Users/alice/.genesis-tools/review/proposals/my file.json";
        const faces = windowFacesFromPs({
            processes: processRows(ps),
            launcherPath: LAUNCHER,
            stalePids: new Set(["101"]),
            records: new Map([[101, ["--review", "--proposal", proposal]]]),
            windows: new Map([
                [
                    101,
                    [
                        ["--review", "--proposal", proposal],
                        ["--review", "--repo", "/work/shop"],
                    ],
                ],
            ]),
        });
        expect(faces).toEqual([
            { pid: 101, kind: "review", argv: ["--review", "--proposal", proposal], lossless: true },
            { pid: 101, kind: "review", argv: ["--review", "--repo", "/work/shop"], lossless: true },
        ]);
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

    it("of the review process's windows, only the one that was in front activates, and it starts last", () => {
        const proposal = "/Users/alice/.genesis-tools/review/proposals/one.json";
        const reviews = windowFacesFromPs({
            processes: processRows(`101 ${LAUNCHER} --review --proposal ${proposal}`),
            launcherPath: LAUNCHER,
            stalePids: new Set(["101"]),
            records: new Map([[101, ["--review", "--proposal", proposal]]]),
            windows: new Map([
                [
                    101,
                    [
                        ["--review", "--proposal", proposal],
                        ["--review", "--repo", "/work/shop"],
                    ],
                ],
            ]),
            fronts: new Map([[101, 0]]),
        });

        expect(relaunchPlan(reviews, 101)).toEqual([
            { pid: 101, kind: "review", argv: ["--review", "--repo", "/work/shop", "--no-activate"], activate: false },
            { pid: 101, kind: "review", argv: ["--review", "--proposal", proposal], activate: true },
        ]);
    });

    it("never runs a hub's one-shot action again", () => {
        const argv = [
            "--hub",
            "--timeline-open",
            "t1",
            "--timeline-action",
            "a",
            "--palette",
            "--find",
            "x",
            "--digest",
            "--width",
            "900",
        ];

        expect(withoutHubActions(argv)).toEqual(["--hub", "--width", "900"]);
        expect(relaunchPlan([{ pid: 4, kind: "hub", argv, lossless: true }], 4)[0].argv).toEqual([
            "--hub",
            "--width",
            "900",
            "--resume",
        ]);
    });

    it("reopens copies of one window once, the frontmost copy when it is among them", () => {
        const settings = (pid: number): WindowFace => ({ pid, kind: "settings", argv: ["--window"], lossless: true });
        const plan = relaunchPlan([settings(5), settings(6), settings(7), ...faces], 6);

        expect(plan.filter((step) => step.kind === "settings")).toEqual([
            { pid: 6, kind: "settings", argv: ["--window"], activate: true },
        ]);
        expect(plan.map((step) => step.kind)).toEqual(["review", "hub", "settings"]);
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

    it("reads a review process's open windows", () => {
        const dir = mkdtempSync(join(tmpdir(), "faces-"));
        writeFileSync(
            join(dir, "21.json"),
            '{"pid":21,"argv":["--review","--repo","/a"],"windows":[["--review","--repo","/a"],["--review","--repo","/b"],[2]]}'
        );
        writeFileSync(join(dir, "22.json"), '{"pid":22,"argv":["--hub"]}');
        expect([...readFaceWindows(dir)]).toEqual([
            [
                21,
                [
                    ["--review", "--repo", "/a"],
                    ["--review", "--repo", "/b"],
                ],
            ],
        ]);
    });

    it("reads which review window was in front, counted among the readable windows", () => {
        const dir = mkdtempSync(join(tmpdir(), "faces-"));
        writeFileSync(
            join(dir, "21.json"),
            '{"pid":21,"argv":["--review"],"windows":[[2],["--review","--repo","/a"],["--review","--repo","/b"]],"front":2}'
        );
        writeFileSync(join(dir, "22.json"), '{"pid":22,"argv":["--review"],"windows":[["--review"]],"front":5}');
        writeFileSync(join(dir, "23.json"), '{"pid":23,"argv":["--review"],"windows":[["--review"]]}');
        expect([...readFaceFrontWindows(dir)]).toEqual([[21, 1]]);
    });

    it("answers no records, never an error, when the folder cannot be listed", () => {
        const notAFolder = join(mkdtempSync(join(tmpdir(), "faces-")), "faces");
        writeFileSync(notAFolder, "a file where the folder should be");
        expect(readFaceRecords(notAFolder).size).toBe(0);
    });
});

describe("the link relay", () => {
    it("starts in the background with its own flag, and is never reopened as a window", () => {
        expect(linkRelayOpenArgs("/Apps/Example.app")).toEqual([
            "open",
            "-n",
            "-g",
            "/Apps/Example.app",
            "--args",
            "--link-relay",
        ]);
        expect(windowFaceKind(["--link-relay"])).toBeNull();
    });
});

describe("a rebuild reopens exactly the faces it stopped", () => {
    const BUNDLE = "/Users/alice/Applications/GenesisTools.app";
    const ps = (...lines: string[]) => lines.join("\n");
    const plan = (options: { psStdout: string; stalePids: string[]; frontPid?: number }) =>
        relaunchCommands(
            planRelaunch({
                processes: processRows(options.psStdout),
                launcherPath: LAUNCHER,
                stalePids: new Set(options.stalePids),
                records: new Map(),
                frontPid: () => options.frontPid ?? null,
            }),
            BUNDLE
        ).map((command) => command.args);

    it("starts the widget it stopped again, behind the front app, without its one-shot settings or session", () => {
        const listing = ps(
            `  301 ${LAUNCHER} --link-relay`,
            `  302 ${LAUNCHER} --widget --session-key local:codex:abc --settings`,
            `  303 ${LAUNCHER} --hub --mode sessions --resume --no-activate`
        );

        expect(plan({ psStdout: listing, stalePids: ["301", "302", "303"], frontPid: 999 })).toEqual([
            ["open", "-n", "-g", BUNDLE, "--args", "--link-relay"],
            ["open", "-n", "-g", BUNDLE, "--args", "--widget", "--ensure-running", "--no-activate"],
            ["open", "-n", "-g", BUNDLE, "--args", "--hub", "--mode", "sessions", "--resume", "--no-activate"],
        ]);
    });

    it("starts the feature settings face again without its page, under its new name", () => {
        const listing = ps(`  311 ${LAUNCHER} --clicky --page widgets.general`);

        expect(plan({ psStdout: listing, stalePids: ["311"] })).toEqual([
            ["open", "-n", "-g", BUNDLE, "--args", "--link-relay"],
            ["open", "-n", "-g", BUNDLE, "--args", "--features", "--no-activate"],
        ]);
    });

    it("never starts a face that was not running, nor a relay for short-lived faces alone", () => {
        const hubOnly = ps(`  321 ${LAUNCHER} --hub --mode sessions`);
        const commands = plan({ psStdout: hubOnly, stalePids: ["321"] });

        expect(commands.some((args) => args.includes("--widget"))).toBe(false);
        expect(commands.some((args) => args.includes("--features"))).toBe(false);
        expect(commands).toHaveLength(2);

        const shortLived = ps(`  331 ${LAUNCHER} --rpc {}`, `  332 ${LAUNCHER} --notify`, `  333 ${LAUNCHER} --widget`);
        expect(plan({ psStdout: shortLived, stalePids: ["331", "332"] })).toEqual([]);
    });

    it("starts a stopped relay again even when no window face comes back", () => {
        const listing = ps(`  341 ${LAUNCHER} --link-relay`, `  342 ${LAUNCHER} --rpc {}`);

        expect(plan({ psStdout: listing, stalePids: ["341", "342"] })).toEqual([
            ["open", "-n", "-g", BUNDLE, "--args", "--link-relay"],
        ]);
    });

    it("lets the widget take focus only when it was the front face", () => {
        const listing = ps(`  351 ${LAUNCHER} --widget`);

        expect(plan({ psStdout: listing, stalePids: ["351"], frontPid: 351 }).at(-1)).toEqual([
            "open",
            "-n",
            BUNDLE,
            "--args",
            "--widget",
            "--ensure-running",
        ]);
    });
});
