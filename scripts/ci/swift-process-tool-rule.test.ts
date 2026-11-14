import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { checkSwiftSource } from "./lint-rules";
import { SWIFT_PROCESS_TOOL_RATCHET } from "./swift-lint-rules";

const rules = (file: string, source: string) => checkSwiftSource(file, source).map((f) => `${f.rule}:${f.line}`);
const launch = (path: string) =>
    ["let process = Process()", `process.executableURL = URL(fileURLWithPath: "${path}")`].join("\n");

describe("swift-no-process-tool-spawn", () => {
    test("flags ps, lsof and pgrep launched by their absolute path", () => {
        expect(rules("Sources/A.swift", launch("/bin/ps"))).toEqual(["swift-no-process-tool-spawn:2"]);
        expect(rules("Sources/A.swift", launch("/usr/sbin/lsof"))).toEqual(["swift-no-process-tool-spawn:2"]);
        expect(rules("Sources/A.swift", launch("/usr/bin/pgrep"))).toEqual(["swift-no-process-tool-spawn:2"]);
    });

    test("leaves other programs, comments, tests and reasoned ignores alone", () => {
        expect(rules("Sources/A.swift", launch("/usr/bin/git"))).toEqual([]);
        expect(rules("Sources/A.swift", '// process.executableURL = URL(fileURLWithPath: "/bin/ps")')).toEqual([]);
        expect(rules("Tests/ATests.swift", launch("/bin/ps"))).toEqual([]);
        expect(
            rules(
                "Sources/A.swift",
                `let process = Process()\n// lint-rules-ignore: once per click, 3 s timeout, needs the tty column\nprocess.executableURL = URL(fileURLWithPath: "/bin/ps")`
            )
        ).toEqual([]);
    });

    test("the listed old call sites pass, and only while the ratchet is on", () => {
        const [file] = [...SWIFT_PROCESS_TOOL_RATCHET.keys()];

        expect(rules(file, launch("/bin/ps"))).toEqual([]);
        expect(checkSwiftSource(file, launch("/bin/ps"), { ratchets: false }).map((f) => f.rule)).toEqual([
            "swift-no-process-tool-spawn",
        ]);
    });

    test("every listed file still exists, so the list can only shrink", () => {
        for (const file of SWIFT_PROCESS_TOOL_RATCHET.keys()) {
            expect(existsSync(join(import.meta.dir, "../..", file))).toBe(true);
        }
    });
});
