import Darwin
import XCTest
@testable import GenesisToolsHost

/// The launcher's signal-death records (Sources/Host/LauncherFailures.swift), and the pins that keep them in the
/// shape `appendFailure` writes (src/utils/cli/failures/record.ts), so `tools genesis-tools logs` reads both alike.
final class LauncherFailuresTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("launcher-failures-" + UUID().uuidString)
    }

    override func tearDownWithError() throws {
        if FileManager.default.fileExists(atPath: directory.path) {
            try FileManager.default.removeItem(at: directory)
        }
    }

    private func run(_ runId: String, startedAt: Date) -> LauncherFailures.Run {
        LauncherFailures.Run(tool: "fixture", toolsRoot: "/repo", runId: runId, startedAt: startedAt, childPid: 4242)
    }

    private func lines(on day: String) throws -> [[String: Any]] {
        let url = LauncherFailures.failureLogURL(day: day, directory: directory)
        return try String(contentsOf: url, encoding: .utf8).split(separator: "\n").compactMap {
            try JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any]
        }
    }

    func testOnlyAToolRunIsPreparedAndItKeepsOrGetsARunId() {
        var plain = ["PATH": "/usr/bin"]
        XCTAssertNil(LauncherFailures.prepare(&plain), "a program `tools` did not hand over is never recorded")
        XCTAssertNil(plain[LauncherFailures.runIdVariable])

        let now = Date(timeIntervalSince1970: 1_000)
        var exec = [LauncherFailures.toolVariable: "watch", LauncherFailures.rootVariable: "/repo"]
        let made = LauncherFailures.prepare(&exec, pid: 77, now: now)
        XCTAssertEqual(made?.tool, "watch")
        XCTAssertEqual(made?.toolsRoot, "/repo")
        XCTAssertEqual(made?.runId, "77-\(String(1_000_000, radix: 36))", "the exec path gets a run id here")
        XCTAssertEqual(exec, [LauncherFailures.runIdVariable: made?.runId ?? ""], "the markers never reach the tool")

        var spawned = [LauncherFailures.toolVariable: "watch", LauncherFailures.runIdVariable: "wrapper-1"]
        XCTAssertEqual(LauncherFailures.prepare(&spawned)?.runId, "wrapper-1", "a spawning wrapper's id is kept")
    }

    func testSignalTableMatchesSignalEnd() {
        XCTAssertEqual(LauncherFailures.kind(of: SIGINT)?.kind, "interrupt")
        XCTAssertEqual(LauncherFailures.kind(of: SIGKILL)?.name, "SIGKILL")
        XCTAssertEqual(LauncherFailures.kind(of: SIGKILL)?.kind, "interrupt")
        XCTAssertEqual(LauncherFailures.kind(of: SIGSEGV)?.kind, "crash")
        XCTAssertEqual(LauncherFailures.kind(of: SIGABRT)?.kind, "crash")
        XCTAssertNil(LauncherFailures.kind(of: SIGPIPE), "SIGPIPE ends `tools x | head` normally")
    }

    func testASignalDeathIsWrittenOnceInTheDayFile() throws {
        let now = Date()
        let day = LauncherFailures.localDay(now)
        let started = now.addingTimeInterval(-2)
        let written = try XCTUnwrap(LauncherFailures.recordSignalDeath(
            run: run("run-a", startedAt: started), signal: SIGKILL, now: now, launcherPid: 4241, cwd: "/work",
            environment: [:], directory: directory))
        XCTAssertNil(LauncherFailures.recordSignalDeath(
            run: run("run-a", startedAt: started), signal: SIGKILL, now: now, environment: [:], directory: directory),
            "a second death of the same run id is not written again")
        XCTAssertNil(LauncherFailures.recordSignalDeath(
            run: run("run-b", startedAt: started), signal: SIGPIPE, now: now, environment: [:], directory: directory))

        let records = try lines(on: day)
        XCTAssertEqual(records.count, 1)
        let record = try XCTUnwrap(records.first)
        XCTAssertEqual(record["kind"] as? String, "interrupt")
        XCTAssertEqual(record["argv"] as? [String], ["[withheld]"])
        XCTAssertTrue(record["command"] is NSNull)
        XCTAssertTrue(record["caller"] is NSNull)
        XCTAssertEqual(record["message"] as? String, "ended by SIGKILL")
        XCTAssertEqual(record["exitCode"] as? Int, 137)
        XCTAssertEqual(record["pid"] as? Int, 4242)
        XCTAssertEqual(record["ppid"] as? Int, 4241)
        XCTAssertEqual(record["cwd"] as? String, "/work")
        XCTAssertEqual(record["runId"] as? String, "run-a")
        XCTAssertEqual(record["durationMs"] as? Int, 2000)
        XCTAssertEqual(written["id"] as? String, record["id"] as? String)
    }

    /// The tool's watcher (it handled the signal and re-raised it) or the spawning `tools` wrapper wrote this run.
    func testARunAnotherWriterAlreadyRecordedGetsNoSecondRecord() throws {
        let now = Date()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let own = #"{"v":1,"id":"x-1","kind":"interrupt","tool":"fixture","at":"2026-10-22T12:00:00.000Z","runId":"run-c"}"#
        try (own + "\n").write(to: LauncherFailures.failureLogURL(day: LauncherFailures.localDay(now), directory: directory),
                               atomically: true, encoding: .utf8)
        XCTAssertNil(LauncherFailures.recordSignalDeath(
            run: run("run-c", startedAt: now), signal: SIGTERM, now: now, environment: [:], directory: directory))
        XCTAssertNotNil(LauncherFailures.recordSignalDeath(
            run: run("run-d", startedAt: now), signal: SIGTERM, now: now, environment: [:], directory: directory))
        XCTAssertEqual(try lines(on: LauncherFailures.localDay(now)).count, 2)
    }

    func testTheDirectoryFollowsGenesisToolsHome() {
        XCTAssertEqual(LauncherFailures.failuresDirectory(environment: ["GENESIS_TOOLS_HOME": "/sandbox"]).path,
                       "/sandbox/.genesis-tools/logs")
        XCTAssertEqual(LauncherFailures.failuresDirectory(environment: [:]).path,
                       NSHomeDirectory() + "/.genesis-tools/logs")
    }

    // MARK: - Pins against the TypeScript sources

    private var src: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
    }

    private func source(_ path: String) throws -> String {
        try String(contentsOf: src.appendingPathComponent(path), encoding: .utf8)
    }

    private func matches(_ pattern: String, in text: String) throws -> [String] {
        let regex = try NSRegularExpression(pattern: pattern, options: [.anchorsMatchLines])
        return regex.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap {
            Range($0.range(at: 1), in: text).map { String(text[$0]) }
        }
    }

    func testTheRecordHasExactlyTheFieldsOfToolFailure() throws {
        let record = try source("utils/cli/failures/record.ts")
        let block = try XCTUnwrap(record.components(separatedBy: "export interface ToolFailure {").dropFirst().first?
            .components(separatedBy: "\n}").first)
        let fields = Set(try matches(#"^    (\w+)\??:"#, in: block))
        XCTAssertTrue(fields.contains("runId"), "the pattern read the interface: \(fields.sorted())")
        let written = LauncherFailures.record(run: run("r", startedAt: Date()), name: "SIGINT", kind: "interrupt",
                                              signal: SIGINT, now: Date(), launcherPid: 1, cwd: "/", environment: [:])
        XCTAssertEqual(Set(written.keys), fields)
        XCTAssertTrue(block.contains("v: 1;"))
        XCTAssertEqual(written["v"] as? Int, 1)
    }

    func testTheDayFileAndDirectoryMatchRecordTs() throws {
        let record = try source("utils/cli/failures/record.ts")
        XCTAssertTrue(record.contains("return join(dir, `${day}-failures.jsonl`);"), "record.ts failureLogPath changed")
        XCTAssertTrue(record.contains(#"return genesisToolsDir("logs");"#), "record.ts failuresDir changed")
        XCTAssertTrue(record.contains("formatLocalDate(new Date(failure.at))"), "the day is no longer the local day")
        let root = try source("utils/storage/root.ts")
        XCTAssertTrue(root.contains(#"join(env.tools.getHome(), ".genesis-tools", ...segments)"#))
        let variables = try source("utils/env/envVariables.ts")
        XCTAssertTrue(variables.contains(#"getHome: () => getTrimmed("GENESIS_TOOLS_HOME") ?? homedir(),"#))
        XCTAssertEqual(LauncherFailures.failureLogURL(day: "2026-10-22", directory: URL(fileURLWithPath: "/d")).path,
                       "/d/2026-10-22-failures.jsonl")
    }

    func testTheSignalTableAndVariablesMatchTheTypeScriptSide() throws {
        let launcher = try source("utils/cli/failures/launcher.ts")
        func set(_ name: String) throws -> Set<String> {
            let line = try XCTUnwrap(launcher.components(separatedBy: "\n").first { $0.contains("const \(name)") })
            return Set(try matches(#""(SIG\w+)""#, in: line))
        }
        XCTAssertEqual(try set("CRASH_SIGNALS"), Set(LauncherFailures.crashSignals.values))
        XCTAssertEqual(try set("INTERRUPT_SIGNALS"), Set(LauncherFailures.interruptSignals.values))
        XCTAssertTrue(launcher.contains(#"export const WITHHELD_ARGV = ["[withheld]"];"#))

        let runId = try source("utils/cli/failures/run-id.ts")
        XCTAssertTrue(runId.contains(#"RUN_ID_ENV = "\#(LauncherFailures.runIdVariable)""#))
        XCTAssertTrue(runId.contains(#"RUN_TOOL_ENV = "\#(LauncherFailures.toolVariable)""#))
        XCTAssertTrue(runId.contains(#"RUN_ROOT_ENV = "\#(LauncherFailures.rootVariable)""#))
    }
}
