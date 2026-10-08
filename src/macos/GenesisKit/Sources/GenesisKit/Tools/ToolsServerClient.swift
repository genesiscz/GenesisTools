import Darwin
import Foundation
import os

private let serverLog = Logger(subsystem: "dev.foltyn.genesis", category: "tools-server")

/// A client for a resident `tools` server: line-delimited JSON over a unix socket, the request being the same argv
/// the CLI takes (`tools hub serve`, src/hub/server/protocol.ts). Every method answers nil when the server cannot
/// serve the request (not running, an argv it has no door for, the connection dropped): the caller then runs the
/// same argv as a process. So this type only ever makes a call cheaper, never different.
///
/// One connection, opened on first use and again after a drop. Reads are event-driven (a dispatch source on the
/// socket); nothing polls. When the socket does not answer, `startServer` runs, at most once per `startEvery`.
public final class ToolsServerClient: @unchecked Sendable {
    public struct End: Sendable {
        public let exit: Int32
        public let stderr: String
        /// "done", "cancelled", "restart" (the server is going away; subscribe again), "error", or
        /// "disconnected" (the connection dropped).
        public let reason: String
    }

    /// Cancels one subscription. Idempotent.
    public final class Subscription: @unchecked Sendable {
        private let cancelBlock: () -> Void
        private let lock = NSLock()
        private var cancelled = false

        init(cancel: @escaping () -> Void) {
            self.cancelBlock = cancel
        }

        public func stop() {
            lock.lock()
            let first = !cancelled
            cancelled = true
            lock.unlock()
            if first { cancelBlock() }
        }
    }

    public static func defaultSocketPath(home: URL = FileManager.default.homeDirectoryForCurrentUser) -> String {
        home.appendingPathComponent(".genesis-tools/hub/server/hub.sock").path
    }

    private struct StreamHandlers {
        let onLines: @MainActor ([String]) -> Void
        let onEnd: @MainActor (End) -> Void
    }

    public let socketPath: String
    private let startServer: (@Sendable () -> Void)?
    private let startEvery: TimeInterval
    private let queue = DispatchQueue(label: "dev.foltyn.genesis.tools-server", qos: .userInitiated)
    private let lock = NSLock()
    private let writeLock = NSLock()
    private var fd: Int32 = -1
    /// Counts connections. A descriptor number can come back for a newer connection; a generation never does,
    /// so a late failure of an old connection can only ever end that one.
    private var generation = 0
    private var source: DispatchSourceRead?
    private var nextId = 1
    private var calls: [Int: (ToolsRunResult?) -> Void] = [:]
    private var streams: [Int: StreamHandlers] = [:]
    private var lastStart: Date?
    private var connectedAt: Date?

    public init(
        socketPath: String = ToolsServerClient.defaultSocketPath(),
        startEvery: TimeInterval = 60,
        startServer: (@Sendable () -> Void)? = nil
    ) {
        self.socketPath = socketPath
        self.startEvery = startEvery
        self.startServer = startServer
    }

    deinit {
        source?.cancel()
    }

    // MARK: - Public

    /// The server's answer to `tools <argv…>`, or nil: run the process. A cancelled task gets nil at once, and
    /// the server is told to stop the call; the caller checks `Task.isCancelled` before running a process.
    public func call(argv: [String], timeoutSeconds: Int, traceId: String? = nil) async -> ToolsRunResult? {
        let once = Once()
        let pending = PendingCall()
        return await withTaskCancellationHandler {
            await withCheckedContinuation { (continuation: CheckedContinuation<ToolsRunResult?, Never>) in
                pending.resume = { result in
                    if once.take() { continuation.resume(returning: result) }
                }
                guard let id = send(op: "call", argv: argv, timeoutMs: timeoutSeconds * 1000, traceId: traceId, onCall: { result in
                    pending.resume?(result)
                }) else {
                    pending.resume?(nil)
                    return
                }

                pending.id = id
                // Cancelled while the request was being sent: the handler below ran before the id existed.
                if Task.isCancelled {
                    self.cancelCall(id)
                    pending.resume?(nil)
                    return
                }

                // The deadline: an answer that does not come in time is a nil, and the caller's process runs instead.
                queue.asyncAfter(deadline: .now() + .seconds(timeoutSeconds + 1)) { [weak self] in
                    guard once.take() else { return }
                    self?.lock.withLock { _ = self?.calls.removeValue(forKey: id) }
                    serverLog.info("call timed out: \(argv.prefix(3).joined(separator: " "), privacy: .public)")
                    continuation.resume(returning: nil)
                }
            }
        } onCancel: { [weak self] in
            if let id = pending.id { self?.cancelCall(id) }
            pending.resume?(nil)
        }
    }

    /// Forgets call `id` and asks the server to stop it.
    private func cancelCall(_ id: Int) {
        let known = lock.withLock { calls.removeValue(forKey: id) != nil }
        if known { write(["id": id, "op": "cancel"]) }
    }

    /// The same, blocking the calling thread (never the main thread) for at most `timeout` seconds.
    public func callSync(argv: [String], timeout: TimeInterval, traceId: String? = nil) -> ToolsRunResult? {
        let done = DispatchSemaphore(value: 0)
        let box = ResultBox()
        guard let id = send(op: "call", argv: argv, timeoutMs: Int(timeout * 1000), traceId: traceId, onCall: { result in
            box.value = result
            done.signal()
        }) else { return nil }

        if done.wait(timeout: .now() + timeout + 1) == .timedOut {
            lock.withLock { _ = calls.removeValue(forKey: id) }
            return nil
        }

        return box.value
    }

    /// Follows `tools <argv…>` (a `--live` command): lines arrive on the main queue, a burst in one call; `onEnd` runs
    /// once. Nil means the server cannot follow it: start the process.
    public func subscribe(
        argv: [String],
        traceId: String? = nil,
        onLines: @escaping @MainActor ([String]) -> Void,
        onEnd: @escaping @MainActor (End) -> Void
    ) -> Subscription? {
        let handlers = StreamHandlers(onLines: onLines, onEnd: onEnd)
        guard let id = send(op: "subscribe", argv: argv, timeoutMs: nil, traceId: traceId, stream: handlers) else { return nil }

        return Subscription { [weak self] in
            guard let self else { return }
            let known = self.lock.withLock { self.streams.removeValue(forKey: id) != nil }
            if known {
                self.write(["id": id, "op": "cancel"])
            }
        }
    }

    /// True when a server answers right now (connects without starting one).
    public var isConnected: Bool {
        lock.withLock { fd >= 0 }
    }

    // MARK: - Connection

    /// Registers the request and writes it; nil when no connection could be made.
    private func send(
        op: String,
        argv: [String],
        timeoutMs: Int?,
        traceId: String?,
        onCall: ((ToolsRunResult?) -> Void)? = nil,
        stream: StreamHandlers? = nil
    ) -> Int? {
        guard connectIfNeeded() else { return nil }

        let id: Int = lock.withLock {
            let id = nextId
            nextId += 1
            if let onCall { calls[id] = onCall }
            if let stream { streams[id] = stream }
            return id
        }
        var message: [String: Any] = ["id": id, "op": op, "argv": argv]
        if let timeoutMs { message["timeoutMs"] = timeoutMs }
        if let traceId { message["traceId"] = traceId }
        // A failed write takes this request out BEFORE the disconnect, which answers every pending
        // request: the caller learns of the failure once, from the nil, and never also from its callback.
        let attempt = writeOnce(message)
        if !attempt.written {
            lock.withLock {
                calls.removeValue(forKey: id)
                streams.removeValue(forKey: id)
            }
            // Only the connection the write used: a reconnect in between keeps its newer one.
            if let connection = attempt.connection { disconnect(connection: connection) }
            return nil
        }

        return id
    }

    private func connectIfNeeded() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if fd >= 0 { return true }

        let socketFd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard socketFd >= 0 else { return false }

        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = Array(socketPath.utf8)
        let capacity = MemoryLayout.size(ofValue: address.sun_path)
        guard pathBytes.count < capacity else {
            close(socketFd)
            return false
        }

        withUnsafeMutableBytes(of: &address.sun_path) { raw in
            raw.copyBytes(from: pathBytes)
            raw[pathBytes.count] = 0
        }
        var noSigPipe: Int32 = 1
        setsockopt(socketFd, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))
        // A server that stops reading must not block a write (and the main actor behind `subscribe`)
        // forever: past this a write fails, the client disconnects, and the caller runs the process.
        var sendTimeout = timeval(tv_sec: 2, tv_usec: 0)
        setsockopt(socketFd, SOL_SOCKET, SO_SNDTIMEO, &sendTimeout, socklen_t(MemoryLayout<timeval>.size))
        let length = socklen_t(MemoryLayout<sockaddr_un>.size)
        let connected = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(socketFd, $0, length) }
        }
        guard connected == 0 else {
            close(socketFd)
            requestStartLocked()
            return false
        }

        fd = socketFd
        generation += 1
        let connection = generation
        connectedAt = Date()
        // The partial line belongs to this connection alone and lives on its read source's queue, so a
        // reconnect on another thread never resets bytes a read handler is still splitting.
        let lines = LineSplitter()
        let readSource = DispatchSource.makeReadSource(fileDescriptor: socketFd, queue: queue)
        readSource.setEventHandler { [weak self] in self?.readAvailable(socketFd, connection: connection, lines: lines) }
        // Closed under the writers' lock: a write that holds it keeps the descriptor (and its number) its own.
        readSource.setCancelHandler { [writeLock] in writeLock.withLock { _ = close(socketFd) } }
        source = readSource
        readSource.resume()
        serverLog.info("connected to \(self.socketPath, privacy: .public)")
        return true
    }

    /// Caller holds the lock.
    private func requestStartLocked() {
        guard let startServer else { return }
        if let lastStart, Date().timeIntervalSince(lastStart) < startEvery { return }

        lastStart = Date()
        serverLog.info("no server on \(self.socketPath, privacy: .public); starting one")
        DispatchQueue.global(qos: .utility).async { startServer() }
    }

    @discardableResult
    private func write(_ message: [String: Any]) -> Bool {
        let attempt = writeOnce(message)
        // Only this connection: a failed write must not end a newer one a reconnect already made.
        if !attempt.written, let connection = attempt.connection { disconnect(connection: connection) }
        return attempt.written
    }

    /// One message on the current connection, and that connection's generation (nil when there was none).
    private func writeOnce(_ message: [String: Any]) -> (written: Bool, connection: Int?) {
        guard var data = try? JSONSerialization.data(withJSONObject: message) else { return (false, nil) }

        data.append(0x0A)
        var socketFd: Int32 = -1
        var connection: Int?

        // One writer at a time, so two requests never interleave on the socket. The descriptor is read
        // inside the writers' lock, which its close also takes: it cannot be closed or reused mid-write.
        let written: Bool = writeLock.withLock {
            (socketFd, connection) = lock.withLock { (fd, fd >= 0 ? generation : nil) }
            guard socketFd >= 0 else { return false }

            return data.withUnsafeBytes { raw -> Bool in
                var offset = 0
                while offset < raw.count {
                    let count = Darwin.write(socketFd, raw.baseAddress! + offset, raw.count - offset)
                    if count < 0 {
                        if errno == EINTR { continue }
                        return false
                    }

                    offset += count
                }
                return true
            }
        }
        return (written, connection)
    }

    private func readAvailable(_ socketFd: Int32, connection: Int, lines: LineSplitter) {
        var chunk = [UInt8](repeating: 0, count: 65536)
        let count = read(socketFd, &chunk, chunk.count)
        if count <= 0 {
            if count < 0, errno == EAGAIN || errno == EINTR { return }
            // Only this connection: a late callback of an old socket must not end its successor.
            disconnect(connection: connection)
            return
        }

        for line in lines.push(chunk[0..<count]) {
            handle(line)
        }
    }

    private func handle(_ line: Data) {
        guard let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
              let id = object["id"] as? Int
        else {
            serverLog.error("unreadable server line (\(line.count) bytes)")
            return
        }

        if let lines = object["lines"] as? [String] {
            guard let handlers = lock.withLock({ streams[id] }) else { return }
            DispatchQueue.main.async { MainActor.assumeIsolated { handlers.onLines(lines) } }
            return
        }

        if object["end"] as? Bool == true {
            if object["reason"] as? String == "restart" {
                // The server is going away on purpose: the next failed connect may start its successor at once.
                lock.withLock { lastStart = nil }
            }

            guard let handlers = lock.withLock({ streams.removeValue(forKey: id) }) else { return }
            let end = End(
                exit: Int32(object["exit"] as? Int ?? 0),
                stderr: object["stderr"] as? String ?? "",
                reason: object["reason"] as? String ?? "done"
            )
            DispatchQueue.main.async { MainActor.assumeIsolated { handlers.onEnd(end) } }
            return
        }

        if let callback = lock.withLock({ calls.removeValue(forKey: id) }) {
            guard object["ok"] as? Bool == true else {
                callback(nil)
                return
            }

            callback(ToolsRunResult(
                stdout: object["stdout"] as? String ?? "",
                stderr: object["stderr"] as? String ?? "",
                exitCode: Int32(object["exit"] as? Int ?? 1),
                wallMs: object["ms"] as? Int ?? 0
            ))
            return
        }

        // A subscribe the server refused (unsupported, draining): end it so the caller starts the process.
        if object["ok"] as? Bool == false, let handlers = lock.withLock({ streams.removeValue(forKey: id) }) {
            let end = End(exit: 1, stderr: "", reason: object["code"] as? String ?? "unsupported")
            DispatchQueue.main.async { MainActor.assumeIsolated { handlers.onEnd(end) } }
        }
    }

    private func disconnect(connection expected: Int? = nil) {
        let (pending, open, readSource): ([(ToolsRunResult?) -> Void], [StreamHandlers], DispatchSourceRead?) = lock.withLock {
            if let expected, generation != expected || fd < 0 {
                return ([], [], nil)
            }
            let pending = Array(calls.values)
            let open = Array(streams.values)
            let readSource = source
            calls.removeAll()
            streams.removeAll()
            source = nil
            fd = -1
            // A server that served for a while and then went away (a restart after a code change, the memory
            // cap) may be replaced at once. One that dies right after connecting keeps the start throttle.
            if let connectedAt, Date().timeIntervalSince(connectedAt) > 30 { lastStart = nil }
            connectedAt = nil
            return (pending, open, readSource)
        }
        readSource?.cancel()
        serverLog.info("disconnected: \(pending.count) calls and \(open.count) follows go to processes")
        for callback in pending { callback(nil) }
        let end = End(exit: 1, stderr: "", reason: "disconnected")
        for handlers in open {
            DispatchQueue.main.async { MainActor.assumeIsolated { handlers.onEnd(end) } }
        }
    }
}

/// One connection's partial line. Touched only from that connection's read source, on the I/O queue.
///
/// A reply of several MB arrives in 64 KB reads. Each read used to search the whole partial line again from its start
/// (`Collection.firstIndex`, a byte at a time) and copy it, so one reply cost time quadratic in its size; an idle hub
/// spent most of its I/O queue there (2026-10-08). Only the new bytes are searched now (memchr), and the partial
/// line is copied only when a newline ends a line before it.
final class LineSplitter: @unchecked Sendable {
    private var buffer = Data()
    /// Bytes at the buffer's start already searched: none of them is a newline.
    private var searched = 0

    func push(_ bytes: ArraySlice<UInt8>) -> [Data] {
        buffer.append(contentsOf: bytes)
        var lines: [Data] = []
        var lineStart = 0
        buffer.withUnsafeBytes { raw in
            guard let base = raw.baseAddress else { return }
            var from = searched
            while from < raw.count, let hit = memchr(base + from, 0x0A, raw.count - from) {
                let newline = base.distance(to: UnsafeRawPointer(hit))
                if newline > lineStart { lines.append(Data(bytes: base + lineStart, count: newline - lineStart)) }
                lineStart = newline + 1
                from = lineStart
            }
        }
        if lineStart > 0 { buffer = buffer.subdata(in: lineStart..<buffer.count) }
        searched = buffer.count
        return lines
    }
}

/// One async call's id and its single resume, shared with its cancellation handler.
private final class PendingCall: @unchecked Sendable {
    private let lock = NSLock()
    private var _id: Int?
    private var _resume: ((ToolsRunResult?) -> Void)?

    var id: Int? {
        get { lock.withLock { _id } }
        set { lock.withLock { _id = newValue } }
    }

    var resume: ((ToolsRunResult?) -> Void)? {
        get { lock.withLock { _resume } }
        set { lock.withLock { _resume = newValue } }
    }
}

private final class Once: @unchecked Sendable {
    private let lock = NSLock()
    private var taken = false

    func take() -> Bool {
        lock.withLock {
            if taken { return false }
            taken = true
            return true
        }
    }
}

private final class ResultBox: @unchecked Sendable {
    var value: ToolsRunResult?
}
