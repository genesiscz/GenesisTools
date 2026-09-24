import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    DEFAULT_CLONE,
    diffGoTests,
    parseGoTestNames,
    parseTwins,
    type ReconcileReport,
    readPinnedSha,
    reconcile,
} from "./agent-harness-reconcile";

const GO_SOURCE = `package coordinator

import "testing"

func TestMain(m *testing.M) {}

func TestCoordinatorStops(t *testing.T) {
	t.Run("sub", func(t *testing.T) {})
}

func Testify(t *testing.T) {}

func FuzzCoordinatorFaults(f *testing.F) {}

func (fake *fakeStore) TestLike() {}

func helper(t *testing.T) {}

func TestCoordinator_Underscore(t *testing.T) {}
`;

const TWIN_SOURCE = `import { describe, expect, test } from "bun:test";

describe("stop_test.go", () => {
    test("TestCoordinatorStops", async () => {
        expect(1).toBe(1);
    });

    // PORT-NA: needs the shell runtime,
    // which is not ported.
    test.skip("TestCoordinatorShell", () => {});

    test.todo("TestCoordinatorLater"); // PORT-DEFECT: tracked in notes #2
});

describe("fault_fuzz_test.go", () => {
    test("FuzzCoordinatorFaults (cancel site)", async () => {});

    test.only('helper works', () => {});
});

describe.skipIf(oracle)("slurp_test.go", () => {
    test.skipIf(oracle)("TestSlurpChannelPreservesOrder", async () => {});
});
`;

describe("parseGoTestNames", () => {
    test("keeps Test and Fuzz functions, drops TestMain, helpers, methods and lowercase continuations", () => {
        expect(parseGoTestNames(GO_SOURCE)).toEqual([
            "TestCoordinatorStops",
            "FuzzCoordinatorFaults",
            "TestCoordinator_Underscore",
        ]);
    });
});

describe("parseTwins", () => {
    const twins = parseTwins(TWIN_SOURCE, "coordinator.stop.test.ts");

    test("records every test call with its mode, describe and line", () => {
        expect(twins.map((twin) => [twin.title, twin.mode, twin.describe, twin.line])).toEqual([
            ["TestCoordinatorStops", "test", "stop_test.go", 4],
            ["TestCoordinatorShell", "skip", "stop_test.go", 10],
            ["TestCoordinatorLater", "todo", "stop_test.go", 12],
            ["FuzzCoordinatorFaults (cancel site)", "test", "fault_fuzz_test.go", 16],
            ["helper works", "only", "fault_fuzz_test.go", 18],
            ["TestSlurpChannelPreservesOrder", "test", "slurp_test.go", 22],
        ]);
    });

    test("a describe.skipIf(...) / test.skipIf(...) twin keeps its Go file and is not a skip", () => {
        expect(twins[5]).toMatchObject({ describe: "slurp_test.go", mode: "test", skipped: false });
    });

    test("the twin name is the leading Go identifier of a qualified title", () => {
        expect(twins[3].name).toBe("FuzzCoordinatorFaults");
        expect(twins[4].name).toBe("helper works");
    });

    test("a skipped twin carries the comment block above, or the trailing comment, and its PORT tag", () => {
        expect(twins[1]).toMatchObject({
            skipped: true,
            reason: "PORT-NA: needs the shell runtime, which is not ported.",
            tag: "PORT-NA",
        });
        expect(twins[2]).toMatchObject({
            skipped: true,
            reason: "PORT-DEFECT: tracked in notes #2",
            tag: "PORT-DEFECT",
        });
        expect(twins[0]).toMatchObject({ skipped: false, reason: null, tag: null });
    });
});

describe("reconcile", () => {
    test("reports missing twins, orphans, skips and a twin under the wrong describe", () => {
        const twins = parseTwins(TWIN_SOURCE, "coordinator.stop.test.ts");
        const result = reconcile({
            goByFile: {
                "harness/coordinator/stop_test.go": ["TestCoordinatorStops", "TestCoordinatorShell"],
                "harness/coordinator/fault_fuzz_test.go": ["FuzzCoordinatorFaults"],
                "harness/coordinator/loop_test.go": ["TestCoordinatorLater", "TestCoordinatorUnported"],
                "harness/coordinator/slurp_test.go": ["TestSlurpChannelPreservesOrder"],
            },
            twins,
        });

        expect(result.missing).toEqual([{ file: "harness/coordinator/loop_test.go", name: "TestCoordinatorUnported" }]);
        expect(result.orphans.map((twin) => twin.title)).toEqual(["helper works"]);
        expect(result.skipped.map((twin) => twin.title)).toEqual(["TestCoordinatorShell", "TestCoordinatorLater"]);
        expect(result.misplaced.map(({ twin, goFiles }) => [twin.title, goFiles])).toEqual([
            ["TestCoordinatorLater", ["harness/coordinator/loop_test.go"]],
        ]);
        expect(result.counts).toEqual({ goTests: 6, twins: 6, skipped: 2, missing: 1, orphans: 1 });
    });

    test("a twin file of one package does not cover the same test name in the other package", () => {
        const twins = parseTwins(
            `describe("submission_test.go", () => {\n    test("TestSubmission", () => {});\n});\n`,
            "contextbuilder.test.ts"
        );
        const result = reconcile({
            goByFile: {
                "harness/contextbuilder/submission_test.go": ["TestSubmission"],
                "harness/coordinator/submission_test.go": ["TestSubmission"],
            },
            twins,
        });

        expect(result.missing).toEqual([{ file: "harness/coordinator/submission_test.go", name: "TestSubmission" }]);
        expect(result.orphans).toEqual([]);
    });
});

describe("diffGoTests", () => {
    test("lists added and removed test names per file, and whole files that appear or vanish", () => {
        expect(
            diffGoTests(
                {
                    "harness/coordinator/a_test.go": ["TestKeep", "TestGone"],
                    "harness/coordinator/old_test.go": ["TestOld"],
                    "harness/coordinator/same_test.go": ["TestSame"],
                },
                {
                    "harness/coordinator/a_test.go": ["TestKeep", "TestNew"],
                    "harness/coordinator/new_test.go": ["TestFresh"],
                    "harness/coordinator/same_test.go": ["TestSame"],
                }
            )
        ).toEqual([
            { file: "harness/coordinator/a_test.go", status: "changed", added: ["TestNew"], removed: ["TestGone"] },
            { file: "harness/coordinator/new_test.go", status: "added", added: ["TestFresh"], removed: [] },
            { file: "harness/coordinator/old_test.go", status: "removed", added: [], removed: ["TestOld"] },
        ]);
    });
});

describe("readPinnedSha", () => {
    test("reads the pinned commit line of UPSTREAM.md", () => {
        expect(
            readPinnedSha("# Upstream\n\n- Pinned commit: `df8b0ba560da17fd705d941cbeb75eff86c74a1e` (2026-09-23).\n")
        ).toBe("df8b0ba560da17fd705d941cbeb75eff86c74a1e");
        expect(readPinnedSha("no pin here")).toBeNull();
    });
});

describe("against the real clone", () => {
    test.skipIf(!existsSync(DEFAULT_CLONE))("the port has no missing twin and no orphan", () => {
        const proc = Bun.spawnSync(["bun", resolve(import.meta.dir, "agent-harness-reconcile.ts"), "--json"], {
            env: process.env,
            stdout: "pipe",
            stderr: "pipe",
        });
        const report: ReconcileReport = SafeJSON.parse(proc.stdout.toString(), { strict: true });

        expect({ exitCode: proc.exitCode, missing: report.missing, orphans: report.orphans }).toEqual({
            exitCode: 0,
            missing: [],
            orphans: [],
        });
    });
});

describe("review round 3 regressions", () => {
    test("a commented-out test call is not a twin", () => {
        const source = [
            'describe("stop_test.go", () => {',
            '    // test("TestCoordinatorStops", async () => {});',
            "    /*",
            '     * test("TestCoordinatorShell", async () => {});',
            "     */",
            '    test("TestCoordinatorLater", async () => {});',
            '    const value = 1; // test("TestCoordinatorTrailing", () => {});',
            "});",
        ].join("\n");
        expect(parseTwins(source, "coordinator.stop.test.ts").map((twin) => twin.title)).toEqual([
            "TestCoordinatorLater",
        ]);
    });

    test("a twin in a file outside the two twin families covers nothing and is an orphan", () => {
        const twins = parseTwins('test("TestCoordinatorStops", async () => {});', "unrelated.test.ts");
        const result = reconcile({ goByFile: { "harness/coordinator/stop_test.go": ["TestCoordinatorStops"] }, twins });
        expect(result.missing).toEqual([{ file: "harness/coordinator/stop_test.go", name: "TestCoordinatorStops" }]);
        expect(result.orphans.map((twin) => twin.title)).toEqual(["TestCoordinatorStops"]);
    });
});
