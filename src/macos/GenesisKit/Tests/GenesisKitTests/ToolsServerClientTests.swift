import Darwin
import XCTest
@testable import GenesisKit

/// A unix-socket server on a thread, one connection at a time: each request line goes to `reply`, whose lines
/// are written back. `fragmented` writes every answer in two pieces; `breakFirst` answers the first connection's
/// first request with half a line and hangs up, so the client has to reconnect.
private final class FakeServer: @unchecked Sendable {
    let path: String
    private let listenFd: Int32
    private let reply: @Sendable ([String: Any]) -> [[String: Any]]
    private let fragmented: Bool
    private let breakFirst: Bool
    private let lock = NSLock()
    private var stopped = false
    private var active: Int32 = -1

    init(fragmented: Bool = false, breakFirst: Bool = false, reply: @escaping @Sendable ([String: Any]) -> [[String: Any]]) throws {
        path = NSTemporaryDirectory() + "gk-\(UUID().uuidString.prefix(8)).sock"
        self.reply = reply
        self.fragmented = fragmented
        self.breakFirst = breakFirst
        listenFd = socket(AF_UNIX, SOCK_STREAM, 0)
        var address = Self.address(path)
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(listenFd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bound == 0, listen(listenFd, 4) == 0 else { throw NSError(domain: "FakeServer", code: Int(errno)) }

        Thread.detachNewThread { [self] in serve() }
    }

    private static func address(_ path: String) -> sockaddr_un {
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        withUnsafeMutableBytes(of: &address.sun_path) { raw in
            raw.copyBytes(from: bytes)
            raw[bytes.count] = 0
        }
        return address
    }

    /// Ends the serving thread: the open connection is shut down (waking its read) and a connection of
    /// our own wakes the accept, so the thread returns and releases the server for `deinit`.
    func stop() {
        // Under the lock that also guards closing it, so a descriptor number reused elsewhere is never shut down.
        lock.withLock {
            stopped = true
            if active >= 0 { shutdown(active, SHUT_RDWR) }
        }
        let waker = socket(AF_UNIX, SOCK_STREAM, 0)
        var address = Self.address(path)
        _ = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(waker, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        close(waker)
    }

    private func serve() {
        var first = true
        while true {
            let client = accept(listenFd, nil, nil)
            guard client >= 0 else { return }
            let done: Bool = lock.withLock {
                if stopped { return true }
                active = client
                return false
            }
            if done {
                close(client)
                return
            }
            serve(client, breaking: breakFirst && first)
            lock.withLock {
                close(client)
                active = -1
            }
            first = false
        }
    }

    private func serve(_ client: Int32, breaking: Bool) {
        var buffer = Data()
        var chunk = [UInt8](repeating: 0, count: 4096)
        while true {
            let count = read(client, &chunk, chunk.count)
            if count <= 0 { break }
            buffer.append(contentsOf: chunk[0..<count])
            while let newline = buffer.firstIndex(of: 0x0A) {
                let line = buffer[buffer.startIndex..<newline]
                buffer.removeSubrange(buffer.startIndex...newline)
                guard let request = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any] else { continue }
                for answer in reply(request) {
                    var data = (try? JSONSerialization.data(withJSONObject: answer)) ?? Data()
                    data.append(0x0A)
                    if breaking {
                        let half = data.prefix(data.count / 2)
                        _ = half.withUnsafeBytes { write(client, $0.baseAddress, $0.count) }
                        return
                    }
                    if fragmented {
                        let cut = data.count / 2
                        _ = data.prefix(cut).withUnsafeBytes { write(client, $0.baseAddress, $0.count) }
                        usleep(50_000)
                        _ = data.suffix(from: cut).withUnsafeBytes { write(client, $0.baseAddress, $0.count) }
                    } else {
                        _ = data.withUnsafeBytes { write(client, $0.baseAddress, $0.count) }
                    }
                }
            }
        }
    }

    deinit {
        close(listenFd)
        unlink(path)
    }
}

final class ToolsServerClientTests: XCTestCase {
    func testNoServerAnswersNilAndStartsOneOnce() async {
        let starts = Counter()
        let client = ToolsServerClient(socketPath: NSTemporaryDirectory() + "gk-none-\(UUID().uuidString.prefix(8)).sock") {
            starts.increment()
        }
        let first = await client.call(argv: ["hub", "agents", "--json"], timeoutSeconds: 1)
        let second = await client.call(argv: ["hub", "agents", "--json"], timeoutSeconds: 1)
        XCTAssertNil(first)
        XCTAssertNil(second)
        try? await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(starts.value, 1, "the start is throttled")
    }

    func testCallReturnsTheServersAnswerAndNilForAnArgvWithoutADoor() async throws {
        let server = try FakeServer { request in
            let id = request["id"] as? Int ?? 0
            let argv = request["argv"] as? [String] ?? []
            if argv.first == "known" {
                return [["id": id, "ok": true, "stdout": "hi\n", "stderr": "", "exit": 0, "ms": 3]]
            }
            return [["id": id, "ok": false, "code": "unsupported"]]
        }
        defer { server.stop() }
        let client = ToolsServerClient(socketPath: server.path)
        let answer = await client.call(argv: ["known"], timeoutSeconds: 2)
        XCTAssertEqual(answer?.stdout, "hi\n")
        XCTAssertEqual(answer?.exitCode, 0)
        let refused = await client.call(argv: ["other"], timeoutSeconds: 2)
        XCTAssertNil(refused)
        XCTAssertEqual(client.callSync(argv: ["known"], timeout: 2)?.stdout, "hi\n")
    }

    /// A line split across reads is joined, and the half line a dropped connection left behind never
    /// reaches the next connection's answer.
    func testAFragmentedAnswerAfterABrokenConnectionArrivesWhole() async throws {
        let server = try FakeServer(fragmented: true, breakFirst: true) { request in
            let id = request["id"] as? Int ?? 0
            return [["id": id, "ok": true, "stdout": "hi\n", "stderr": "", "exit": 0, "ms": 3]]
        }
        defer { server.stop() }
        let client = ToolsServerClient(socketPath: server.path)
        let broken = await client.call(argv: ["known"], timeoutSeconds: 2)
        XCTAssertNil(broken, "the connection hung up mid-line")
        let answer = await client.call(argv: ["known"], timeoutSeconds: 2)
        XCTAssertEqual(answer?.stdout, "hi\n")
        XCTAssertEqual(answer?.exitCode, 0)
    }

    @MainActor
    func testSubscriptionDeliversLinesThenEnd() async throws {
        let server = try FakeServer { request in
            let id = request["id"] as? Int ?? 0
            guard request["op"] as? String == "subscribe" else { return [] }
            return [["id": id, "lines": ["a", "b"]], ["id": id, "end": true, "exit": 0, "stderr": "", "reason": "restart"]]
        }
        defer { server.stop() }
        let client = ToolsServerClient(socketPath: server.path)
        let ended = expectation(description: "end")
        var lines: [String] = []
        var reason = ""
        let subscription = client.subscribe(argv: ["follow"], onLines: { lines += $0 }, onEnd: { end in
            reason = end.reason
            ended.fulfill()
        })
        XCTAssertNotNil(subscription)
        await fulfillment(of: [ended], timeout: 3)
        XCTAssertEqual(lines, ["a", "b"])
        XCTAssertEqual(reason, "restart")
    }
}

final class ToolsCallTraceTests: XCTestCase {
    func testCredentialFlagValuesAreHiddenAndEverythingElseStays() {
        XCTAssertEqual(
            ToolsCallTrace.redacted(["ai", "x", "--api-key", "sk-1", "--token=abc", "--session", "1b4001ba"]),
            ["ai", "x", "--api-key", "***", "--token=***", "--session", "1b4001ba"]
        )
        XCTAssertEqual(
            ToolsCallTrace.redacted(["mcp-manager", "add", "x", "--headers", "Authorization: Bearer abc", "-H", "x-api-key: k", "--header=Cookie: c"]),
            ["mcp-manager", "add", "x", "--headers", "***", "-H", "***", "--header=***"]
        )
        XCTAssertEqual(ToolsCallTrace.newId().count, 8)
    }
}

private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0

    var value: Int { lock.withLock { count } }

    func increment() {
        lock.withLock { count += 1 }
    }
}
