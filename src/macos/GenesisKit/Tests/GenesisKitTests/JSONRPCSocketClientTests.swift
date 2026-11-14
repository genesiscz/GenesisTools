import Foundation
import XCTest
@testable import GenesisKit

/// The client as every `tools` service's peer: an error answer keeps its `data` when the call asks for it (the Meetings
/// service names each refusal in `data.code`), and the recorder's old name is the same type.
final class JSONRPCSocketClientTests: XCTestCase {
    private var peer: FakeRPCPeer!
    private var client: JSONRPCSocketClient!

    override func setUpWithError() throws {
        peer = FakeRPCPeer()
        try peer.start()
        client = JSONRPCSocketClient(path: peer.path, callbackQueue: DispatchQueue(label: "test.socket-client"))
        try client.connect()
    }

    override func tearDown() {
        client.close()
        peer.stop()
    }

    /// Sends `method`, answers it with `error` and returns what the call ended with.
    private func refused(_ method: String, errorData: Bool, error: [String: Any]) throws -> Error {
        let ended = expectation(description: "\(method) ended")
        var outcome: Result<Any?, Error>?
        let id = client.request(method, params: ["ref": "nope"], timeout: 3, errorData: errorData) { result in
            outcome = result
            ended.fulfill()
        }
        _ = try peer.line { $0["method"] as? String == method }
        peer.send(["jsonrpc": "2.0", "id": id, "error": error])
        wait(for: [ended], timeout: 2)
        guard case let .failure(failure)? = outcome else {
            XCTFail("\(method) succeeded")
            return CancellationError()
        }
        return failure
    }

    func testAnErrorAnswerKeepsItsDataWhenTheCallAsksForIt() throws {
        let error = try refused("meeting.show", errorData: true, error: [
            "code": 1100, "message": "No meeting \"nope\"", "data": ["code": "meeting-not-found"],
        ])
        let remote = try XCTUnwrap(error as? JSONRPCSocketClient.RemoteError, "\(error)")
        XCTAssertEqual(remote.code, 1100)
        XCTAssertEqual(remote.message, "No meeting \"nope\"")
        XCTAssertEqual(remote.decodeData([String: String].self), ["code": "meeting-not-found"])
        XCTAssertEqual(remote.failure, .remote(code: 1100, message: "No meeting \"nope\""))
        XCTAssertEqual(remote.localizedDescription, "No meeting \"nope\"")
    }

    func testAnErrorAnswerWithoutDataHasNone() throws {
        let error = try refused("meetings.list", errorData: true, error: ["code": -32602, "message": "limit: too small"])
        let remote = try XCTUnwrap(error as? JSONRPCSocketClient.RemoteError, "\(error)")
        XCTAssertEqual(remote.code, -32602)
        XCTAssertNil(remote.data)
        XCTAssertNil(remote.decodeData([String: String].self))
    }

    /// The recorder's calls never ask for the data: they still get `Failure.remote`, whatever the answer carries.
    func testACallThatDoesNotAskGetsFailureRemoteAsBefore() throws {
        let error = try refused("edit.apply", errorData: false, error: [
            "code": 1010, "message": "stale revision", "data": ["revision": 4],
        ])
        XCTAssertEqual(error as? JSONRPCSocketClient.Failure, .remote(code: 1010, message: "stale revision"))
        XCTAssertNil(error as? JSONRPCSocketClient.RemoteError)
    }

    /// A socket path longer than a Unix socket address holds (a service in a home deep in a temporary folder) is
    /// reached through a short link; the first client refused it, so a window in a test home never met its service.
    func testAPathLongerThanASocketAddressConnectsThroughAShortLink() throws {
        let files = FileManager.default
        let deep = files.temporaryDirectory
            .appendingPathComponent("gt-socket-test-\(UUID().uuidString)")
            .appendingPathComponent(String(repeating: "a", count: 60))
        try files.createDirectory(at: deep, withIntermediateDirectories: true)
        defer { try? files.removeItem(at: deep.deletingLastPathComponent()) }
        let long = deep.appendingPathComponent("service.sock").path
        // A peer of its own: the fake peer serves one connection, and the set-up client holds the first one's.
        let other = FakeRPCPeer()
        try other.start()
        defer { other.stop() }
        try files.createSymbolicLink(atPath: long, withDestinationPath: other.path)
        XCTAssertGreaterThan(long.utf8.count, 103)

        XCTAssertEqual(JSONRPCSocketClient.connectablePath(peer.path, limit: 104), peer.path, "a path that fits is used as it is")
        let link = try XCTUnwrap(JSONRPCSocketClient.connectablePath(long, limit: 104))
        defer { try? files.removeItem(atPath: link) }
        XCTAssertLessThan(link.utf8.count, 104)
        XCTAssertEqual(try files.destinationOfSymbolicLink(atPath: link), long)
        XCTAssertEqual(JSONRPCSocketClient.connectablePath(long, limit: 104), link, "the same path keeps its link")
        XCTAssertNil(JSONRPCSocketClient.connectablePath(long, limit: 104, linkFolder: deep), "a link folder that is too deep cannot help")

        let far = JSONRPCSocketClient(path: long, callbackQueue: DispatchQueue(label: "test.socket-client.long"))
        defer { far.close() }
        XCTAssertNoThrow(try far.connect())
        let answered = expectation(description: "the peer answered through the link")
        let id = far.request("hello", params: [:], timeout: 3, errorData: false) { result in
            if case .success = result { answered.fulfill() }
        }
        _ = try other.line { $0["method"] as? String == "hello" }
        other.send(["jsonrpc": "2.0", "id": id, "result": ["ok": true]])
        wait(for: [answered], timeout: 2)
    }

    /// Clients that resolve the same long path at once all get its link: a stale link (another destination) was removed
    /// and created again by each, and every client but one failed with EEXIST and fell back as if the path were too long.
    func testClientsThatMakeTheSameLinkAtOnceAllGetIt() throws {
        let files = FileManager.default
        let folder = files.temporaryDirectory.appendingPathComponent("gts-\(UUID().uuidString.prefix(8))")
        try files.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? files.removeItem(at: folder) }
        let long = "/Users/alice/" + String(repeating: "deep/", count: 24) + "service.sock"
        XCTAssertGreaterThan(long.utf8.count, 103)

        for round in 0..<20 {
            let stale = try XCTUnwrap(JSONRPCSocketClient.connectablePath(long, limit: 104, linkFolder: folder))
            try files.removeItem(atPath: stale)
            try files.createSymbolicLink(atPath: stale, withDestinationPath: "/Users/alice/old-\(round).sock")

            let lock = NSLock()
            var links: [String?] = []
            DispatchQueue.concurrentPerform(iterations: 16) { _ in
                let link = JSONRPCSocketClient.connectablePath(long, limit: 104, linkFolder: folder)
                lock.withLock { links.append(link) }
            }
            XCTAssertEqual(links.compactMap { $0 }.count, 16, "round \(round): every client got the link")
            XCTAssertEqual(Set(links.compactMap { $0 }), [stale])
            XCTAssertEqual(try files.destinationOfSymbolicLink(atPath: stale), long)
        }
        let left = try files.contentsOfDirectory(atPath: folder.path)
        XCTAssertEqual(left.count, 1, "no half-made link is left behind: \(left)")
    }

    func testTheRecordersOldNameIsTheSameType() {
        XCTAssertTrue(LiveRecordingRPCClient.self == JSONRPCSocketClient.self)
        let old: LiveRecordingRPCClient = client
        XCTAssertTrue(old === client)
    }
}

final class JSONRPCCallbackTests: XCTestCase {
    func testCallbackSlotsCanChangeWhileCallbacksAreRead() {
        let client = JSONRPCSocketClient(path: "/unused", callbackQueue: .global())
        DispatchQueue.concurrentPerform(iterations: 2000) { index in
            if index.isMultiple(of: 2) {
                client.onNotification = { _, _ in }
                client.onClose = {}
            } else {
                client.onNotification?("changed", nil)
                client.onClose?()
            }
        }
        // Invoking a callback must not hold the slots' lock: a callback may detach itself.
        client.onClose = { client.onNotification = nil }
        client.onClose?()
        client.onClose = nil
        XCTAssertNil(client.onNotification)
    }
}
