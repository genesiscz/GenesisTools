import XCTest
@testable import GenesisKit

@MainActor
final class ToolsLineStreamTests: XCTestCase {
    private func script(_ body: String) throws -> (ToolsBridge, URL) {
        let fm = FileManager.default
        let dir = fm.temporaryDirectory.appendingPathComponent("line-stream-\(UUID().uuidString)", isDirectory: true)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appendingPathComponent("tools")
        try "#!/bin/sh\n\(body)\n".write(to: file, atomically: true, encoding: .utf8)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path)
        return (ToolsBridge(binaryPath: file.path), dir)
    }

    func testDeliversWholeLinesThenTheExit() throws {
        let (bridge, dir) = try script("printf 'one\\ntw'; printf 'o\\nthree\\n'; echo oops >&2; exit 3")
        defer { try? FileManager.default.removeItem(at: dir) }
        var lines: [String] = []
        let exited = expectation(description: "exit")
        var report: ToolsLineStream.Exit?
        let stream = try ToolsLineStream(bridge: bridge, subcommand: "x", args: [], onLines: { lines += $0 }, onExit: {
            report = $0
            exited.fulfill()
        })
        wait(for: [exited], timeout: 5)
        XCTAssertEqual(lines, ["one", "two", "three"])
        XCTAssertEqual(report?.status, 3)
        XCTAssertEqual(report?.stopped, false)
        XCTAssertEqual(report?.stderr, "oops\n")
        _ = stream
    }

    func testGracefulInputEndStillDeliversTheFinalTranscript() throws {
        let (bridge, dir) = try script("echo ready; cat >/dev/null; echo final")
        defer { try? FileManager.default.removeItem(at: dir) }
        let ready = expectation(description: "ready")
        let exited = expectation(description: "exit")
        var lines: [String] = []
        var report: ToolsLineStream.Exit?
        let stream = try ToolsLineStream(bridge: bridge, subcommand: "x", args: [], onLines: {
            lines += $0
            if $0.contains("ready") { ready.fulfill() }
        }, onExit: {
            report = $0
            exited.fulfill()
        })
        wait(for: [ready], timeout: 5)
        stream.finishInput()
        wait(for: [exited], timeout: 5)
        XCTAssertEqual(lines, ["ready", "final"])
        XCTAssertEqual(report?.status, 0)
        XCTAssertEqual(report?.stopped, false)
    }

    func testStopClosesStdinSoAStdinWatcherEnds() throws {
        // `cat` stands in for a `--live` follow: it runs until its stdin closes.
        let (bridge, dir) = try script("echo ready; exec cat")
        defer { try? FileManager.default.removeItem(at: dir) }
        let ready = expectation(description: "ready")
        let exited = expectation(description: "exit")
        var report: ToolsLineStream.Exit?
        let stream = try ToolsLineStream(bridge: bridge, subcommand: "x", args: [], onLines: { _ in ready.fulfill() }, onExit: {
            report = $0
            exited.fulfill()
        })
        wait(for: [ready], timeout: 5)
        stream.stop()
        wait(for: [exited], timeout: 5)
        XCTAssertEqual(report?.stopped, true)
    }
}
