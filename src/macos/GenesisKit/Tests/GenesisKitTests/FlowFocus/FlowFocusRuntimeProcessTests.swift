import Darwin
import Foundation
import XCTest
@testable import GenesisKit

/// Opt-in, real-process lifecycle coverage. Both hosts use a disposable root and disable
/// capture, windows and DND; the only signal target is a child created by this test.
@MainActor
final class FlowFocusRuntimeProcessTests: XCTestCase {
    private struct Receipt: Codable, Equatable {
        let pid: Int32
        let owner: Bool
        let ticking: Bool
        let capturing: Bool
        let dnd: Bool
        let session: Int64?
        let tag: String?
        let hotkeyOff: Bool
    }

    func testWorker() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard let rootPath = environment["FLOW_FOCUS_WORKER_ROOT"],
              let host = environment["FLOW_FOCUS_WORKER_HOST"] else {
            throw XCTSkip("Only launched by the separate-process lifecycle test")
        }
        let root = URL(fileURLWithPath: rootPath, isDirectory: true)
        let runtime = FlowFocusRuntime(dataRoot: root, hostID: host, liveServices: false, presentsWindows: false)
        await runtime.start()
        let receiptURL = root.appendingPathComponent("\(host).json")
        let stopURL = root.appendingPathComponent("\(host).stop")
        let deadline = Date().addingTimeInterval(20)
        var last: Receipt?
        while !FileManager.default.fileExists(atPath: stopURL.path), Date() < deadline {
            let receipt = Receipt(pid: ProcessInfo.processInfo.processIdentifier, owner: runtime.role.isOwner,
                                  ticking: runtime.focus.engine?.isTicking ?? false,
                                  capturing: runtime.focus.recorder?.isCapturing ?? false,
                                  dnd: runtime.focus.orchestrator.isActive,
                                  session: try runtime.focus.store?.openSession()?.id,
                                  tag: runtime.focus.engine?.tag, hotkeyOff: runtime.flow.hotkeyStatus == .off)
            if receipt != last {
                try JSONEncoder().encode(receipt).write(to: receiptURL, options: .atomic)
                last = receipt
            }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        await runtime.stop()
        XCTAssertTrue(FileManager.default.fileExists(atPath: stopURL.path), "worker lifecycle deadline expired")
    }

    func testOwnerCrashTransfersTheExistingSessionToTheOtherProcess() async throws {
        guard ProcessInfo.processInfo.environment["GENESIS_FLOW_PROCESS_TESTS"] == "1" else {
            throw XCTSkip("Set GENESIS_FLOW_PROCESS_TESTS=1 for isolated process lifecycle coverage")
        }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("flow-process-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let app: [String: Any] = ["focus": ["captureEnabled": false, "menuBarStyle": "off",
                                           "timer": ["dndWhileFlowing": false]],
                                   "focusWhileListening": false, "labs": ["dictation": false]]
        try JSONSerialization.data(withJSONObject: ["app": app]).write(to: root.appendingPathComponent("client.json"))
        let first = try launchWorker("first", root: root)
        var second: Process?
        defer {
            for process in [first, second].compactMap({ $0 }) where process.isRunning {
                kill(process.processIdentifier, SIGKILL)
            }
        }
        let initial = try await waitForReceipt("first", root: root) { $0.owner }
        XCTAssertTrue(initial.hotkeyOff)
        XCTAssertFalse(initial.capturing)
        XCTAssertFalse(initial.dnd)
        let peer = try launchWorker("second", root: root)
        second = peer
        let passive = try await waitForReceipt("second", root: root) { !$0.owner }
        XCTAssertNotEqual(initial.pid, passive.pid)
        XCTAssertFalse(passive.ticking)
        XCTAssertFalse(passive.capturing)
        XCTAssertTrue(passive.hotkeyOff)
        let runtimeDirectory = root.appendingPathComponent("feature-runtime")
        let advertised = try FlowFocusLease.readOwner(directory: runtimeDirectory)
        let channel = try FlowFocusMailbox(directory: runtimeDirectory, owner: advertised)
        channel.start()
        defer { channel.stop() }
        let payload = try JSONEncoder().encode(FocusStartCommand(phase: .flow, seconds: 600, tag: "Process fixture"))
        _ = try await channel.request(action: "focus.start", payload: payload)
        let running = try await waitForReceipt("first", root: root) { $0.ticking && $0.session != nil }
        let mirrored = try await waitForReceipt("second", root: root) { $0.session == running.session && $0.tag == "Process fixture" }
        XCTAssertFalse(mirrored.ticking)
        XCTAssertEqual(kill(first.processIdentifier, SIGKILL), 0)
        try await waitForExit(first)
        let takeover = try await waitForReceipt("second", root: root) { $0.owner && $0.ticking }
        XCTAssertEqual(takeover.session, running.session)
        XCTAssertEqual(takeover.tag, "Process fixture")
        XCTAssertFalse(takeover.capturing)
        XCTAssertFalse(takeover.dnd)
        XCTAssertTrue(takeover.hotkeyOff)
        let nextOwner = try FlowFocusLease.readOwner(directory: runtimeDirectory)
        XCTAssertEqual(nextOwner.pid, peer.processIdentifier)
        XCTAssertNotEqual(nextOwner.nonce, advertised.nonce)
        let ledger = try ActivityStore(path: root.appendingPathComponent("activity.db").path, readOnly: true)
        XCTAssertEqual(try ledger.sessions(from: 0, to: Int64.max).count, 1)
        try Data().write(to: root.appendingPathComponent("second.stop"))
        try await waitForExit(peer)
        XCTAssertEqual(peer.terminationStatus, 0)
        let lease = try XCTUnwrap(FlowFocusLease.acquire(directory: runtimeDirectory, hostID: "test.after-shutdown"))
        lease.release()
        print("PROCESS_RECEIPT root=\(root.path) firstPID=\(initial.pid) secondPID=\(passive.pid) session=\(running.session ?? -1) sameSession=true duplicateTicker=false capture=false hotkey=false dnd=false")
    }

    private func launchWorker(_ host: String, root: URL) throws -> Process {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
        process.arguments = ["xctest", "-XCTest", "GenesisKitTests.FlowFocusRuntimeProcessTests/testWorker",
                             Bundle(for: Self.self).bundleURL.path]
        process.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": root.path,
                               "TMPDIR": FileManager.default.temporaryDirectory.path,
                               "FLOW_FOCUS_WORKER_ROOT": root.path, "FLOW_FOCUS_WORKER_HOST": host]
        let log = root.appendingPathComponent("\(host).log")
        FileManager.default.createFile(atPath: log.path, contents: nil)
        let handle = try FileHandle(forWritingTo: log)
        process.standardOutput = handle
        process.standardError = handle
        try process.run()
        try handle.close()
        return process
    }

    private func waitForReceipt(_ host: String, root: URL, matching: (Receipt) -> Bool) async throws -> Receipt {
        let deadline = Date().addingTimeInterval(5)
        let url = root.appendingPathComponent("\(host).json")
        while Date() < deadline {
            if let data = try? Data(contentsOf: url), let receipt = try? JSONDecoder().decode(Receipt.self, from: data), matching(receipt) {
                return receipt
            }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        throw FlowFocusMailbox.Failure.unavailable("Timed out waiting for \(host); inspect \(root.path)")
    }

    private func waitForExit(_ process: Process) async throws {
        let deadline = Date().addingTimeInterval(3)
        while process.isRunning, Date() < deadline { try await Task.sleep(nanoseconds: 100_000_000) }
        XCTAssertFalse(process.isRunning, "owned child did not exit before its deadline")
        if process.isRunning { throw FlowFocusMailbox.Failure.unavailable("Child did not exit") }
    }
}
