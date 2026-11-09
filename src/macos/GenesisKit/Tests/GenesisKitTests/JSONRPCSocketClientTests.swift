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

    func testTheRecordersOldNameIsTheSameType() {
        XCTAssertTrue(LiveRecordingRPCClient.self == JSONRPCSocketClient.self)
        let old: LiveRecordingRPCClient = client
        XCTAssertTrue(old === client)
    }
}
