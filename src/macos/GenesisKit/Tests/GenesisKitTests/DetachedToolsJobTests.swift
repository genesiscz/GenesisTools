import Darwin
import Foundation
import XCTest
@testable import GenesisKit
@testable import GenesisKitDisk

/// A `tools` job whose output goes to files: the starting instance follows it, and a second follower that only
/// has the saved record (an app restart) reads everything from the start and still sees the end.
@MainActor
final class DetachedToolsJobTests: XCTestCase {
    private var directory: URL!

    override func setUp() async throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("detached-job-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func fakeTools(_ body: String) throws -> ToolsBridge {
        let script = directory.appendingPathComponent("tools")
        try ("#!/bin/sh\n" + body).write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        return ToolsBridge(binaryPath: script.path)
    }

    private func paths() -> (String, String) {
        (directory.appendingPathComponent("out.ndjson").path, directory.appendingPathComponent("err.log").path)
    }

    func testTheStarterGetsEveryLineThenTheExitStatus() throws {
        let bridge = try fakeTools("echo one; sleep 0.3; echo \"two $GENESIS_TOOLS_DETACHED\"; echo oops >&2; exit 3\n")
        let (out, err) = paths()
        let (record, process) = try DetachedToolsJob.start(bridge: bridge, subcommand: "du", args: ["index"],
                                                           outputPath: out, errorPath: err)
        var lines: [String] = []
        let done = expectation(description: "exit")
        var exit: DetachedToolsJob.Exit?
        let job = try DetachedToolsJob(record: record, process: process, onLines: { lines += $0 }, onExit: {
            exit = $0
            done.fulfill()
        })
        wait(for: [done], timeout: 10)
        XCTAssertEqual(lines, ["one", "two 1"], "the job tells the tools wrapper it is detached")
        XCTAssertEqual(exit?.status, 3)
        XCTAssertEqual(exit?.stopped, false)
        XCTAssertTrue(exit?.stderr.contains("oops") == true)
        XCTAssertEqual(job.record.argv, ["du", "index"])
    }

    func testALaterFollowerReplaysTheOutputAndSeesTheEndWithoutAStatus() throws {
        let bridge = try fakeTools("echo early; sleep 1; echo late\n")
        let (out, err) = paths()
        let (record, process) = try DetachedToolsJob.start(bridge: bridge, subcommand: "du", args: [],
                                                           outputPath: out, errorPath: err)
        // The app that started it goes away: only the record survives (as a saved file would).
        let saved = try JSONDecoder().decode(DetachedToolsJob.Record.self, from: JSONEncoder().encode(record))
        Thread.sleep(forTimeInterval: 0.3)
        var lines: [String] = []
        let done = expectation(description: "exit")
        var exit: DetachedToolsJob.Exit?
        let follower = try DetachedToolsJob(record: saved, onLines: { lines += $0 }, onExit: {
            exit = $0
            done.fulfill()
        })
        wait(for: [done], timeout: 10)
        XCTAssertEqual(lines, ["early", "late"])
        XCTAssertNil(exit?.status, "only the parent can read the status")
        XCTAssertFalse(process.isRunning)
        XCTAssertEqual(follower.record.pid, record.pid)
    }

    func testStderrReadsOnlyTheTailOfALargeFile() throws {
        let url = directory.appendingPathComponent("err.log")
        let limit = ToolsLineStream.stderrLimit
        var bytes = Data(repeating: 0x61, count: limit + 5000)
        bytes.append(contentsOf: Data("TAIL-MARK".utf8))
        try bytes.write(to: url)
        let tail = DetachedToolsJob.stderrTail(at: url.path, limit: limit)
        let read = try XCTUnwrap(tail.read)
        XCTAssertEqual(read.fileBytes, UInt64(bytes.count))
        XCTAssertEqual(read.count, limit)
        XCTAssertEqual(read.offset, UInt64(bytes.count - limit))
        XCTAssertEqual(tail.data, bytes.suffix(limit))
        XCTAssertEqual(tail.data.suffix(9), Data("TAIL-MARK".utf8))
        let missing = DetachedToolsJob.stderrTail(at: directory.appendingPathComponent("missing.log").path)
        XCTAssertEqual(missing.data, Data())
        XCTAssertNil(missing.read)
        let source = try String(contentsOf: URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/GenesisKit/Tools/DetachedToolsJob.swift"), encoding: .utf8)
        XCTAssertTrue(source.contains("stderrTail(at: record.errorPath)"))
        XCTAssertFalse(source.contains("Data(contentsOf:"))
    }

    func testADetachedIndexBuildDoesNotStopOnStdin() {
        // Its stdin is /dev/null: with --stop-on-stdin the CLI cancels at once (exit 130, seen live 2026-10-14).
        XCTAssertFalse(ToolsDiskProvider.duIndexBuildArguments().contains("--stop-on-stdin"))
        XCTAssertTrue(ToolsDiskProvider.duIndexBuildArguments(stopOnStdin: true).contains("--stop-on-stdin"))
    }

    func testStopEndsTheJobAndSaysSo() throws {
        let bridge = try fakeTools("echo started; exec sleep 30\n")
        let (out, err) = paths()
        let (record, process) = try DetachedToolsJob.start(bridge: bridge, subcommand: "du", args: [],
                                                           outputPath: out, errorPath: err)
        let started = expectation(description: "first line")
        let done = expectation(description: "exit")
        var exit: DetachedToolsJob.Exit?
        let job = try DetachedToolsJob(record: record, process: process, onLines: { _ in started.fulfill() },
                                       onExit: { exit = $0; done.fulfill() })
        wait(for: [started], timeout: 10)
        job.stop()
        wait(for: [done], timeout: 10)
        XCTAssertEqual(exit?.stopped, true)
        XCTAssertFalse(record.isAlive)
    }
}
