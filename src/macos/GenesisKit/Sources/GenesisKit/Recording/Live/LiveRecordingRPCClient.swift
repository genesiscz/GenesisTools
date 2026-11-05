import Darwin
import Foundation

/// A JSON-RPC 2.0 peer over a Unix domain socket, one JSON message per line: the control channel of a live recording,
/// and the recorder host's connection to the recorder service. Calls carry an id and a timeout; a message with a
/// `method` and no `id` is a notification. The peer may also send requests: a registered handler (`answer`) answers
/// each on the same connection, an unknown method gets -32601. Long work reports `$/progress { id, fraction?, label? }`
/// and stops on `$/cancel { id }` (the LSP shape), in both directions. All socket work runs on one private queue;
/// results, notifications, handlers and the close arrive on `callbackQueue`.
public final class LiveRecordingRPCClient: @unchecked Sendable {
    /// The JSON-RPC error codes this transport answers by itself.
    public enum Code {
        public static let invalidRequest = -32600
        public static let methodNotFound = -32601
        public static let invalidParams = -32602
        public static let internalError = -32603
        /// The peer sent `$/cancel` for the request.
        public static let cancelled = 1013
    }

    /// A step of a long call: `$/progress` from the side doing the work.
    public struct CallProgress: Equatable, Sendable {
        public let fraction: Double?
        public let label: String?
    }

    /// A request the peer sent. The handler answers it once through its reply closure; `progress` reports a step,
    /// `onCancel` learns of `$/cancel` (or of the connection ending).
    public final class Incoming: @unchecked Sendable {
        public let method: String
        public let params: Any?
        fileprivate let id: Any
        fileprivate let key: String
        private weak var client: LiveRecordingRPCClient?
        private let lock = NSLock()
        private var cancelled = false
        private var cancelHandlers: [() -> Void] = []

        fileprivate init(method: String, params: Any?, id: Any, key: String, client: LiveRecordingRPCClient) {
            self.method = method
            self.params = params
            self.id = id
            self.key = key
            self.client = client
        }

        /// The params as an object; empty when the request sent none or sent a list.
        public var object: [String: Any] { params as? [String: Any] ?? [:] }

        public var isCancelled: Bool {
            lock.lock()
            defer { lock.unlock() }
            return cancelled
        }

        /// Runs once on the callback queue when the peer cancels or the connection ends; at once when that happened.
        public func onCancel(_ handler: @escaping () -> Void) {
            lock.lock()
            let now = cancelled
            if !now { cancelHandlers.append(handler) }
            lock.unlock()
            if now { handler() }
        }

        /// Sends `$/progress { id, fraction?, label? }` while the request is still open.
        public func progress(fraction: Double? = nil, label: String? = nil) {
            client?.sendProgress(for: self, fraction: fraction, label: label)
        }

        fileprivate func markCancelled(on queue: DispatchQueue) {
            lock.lock()
            guard !cancelled else {
                lock.unlock()
                return
            }
            cancelled = true
            let handlers = cancelHandlers
            cancelHandlers = []
            lock.unlock()
            guard !handlers.isEmpty else { return }
            queue.async { handlers.forEach { $0() } }
        }
    }

    /// Answers one request: call `reply` once with the result (any JSON value, nil for null) or an error. A
    /// `Failure.remote(code:message:)` goes out with its code, a `CancellationError` as 1013, anything else as -32603.
    public typealias Handler = (Incoming, @escaping (Result<Any?, Error>) -> Void) -> Void

    public enum Failure: Error, Equatable, LocalizedError {
        /// The recorder answered with a JSON-RPC error.
        case remote(code: Int, message: String)
        case connect(errno: Int32)
        case pathTooLong
        case notConnected
        case timeout(method: String)
        case closed
        case badMessage

        public var errorDescription: String? {
            switch self {
            case let .remote(_, message): return message
            case let .connect(code): return "the recorder's socket refused (\(String(cString: strerror(code))))"
            case .pathTooLong: return "the socket path is longer than a Unix socket allows"
            case .notConnected: return "not connected to the recorder"
            case let .timeout(method): return "the recorder did not answer \(method) in time"
            case .closed: return "the recorder closed the connection"
            case .badMessage: return "the call could not be encoded"
            }
        }
    }

    public let path: String
    /// `(method, params)` of each notification.
    public var onNotification: ((String, Any?) -> Void)?
    /// Once, when the connection ends for any reason after a successful `connect`.
    public var onClose: (() -> Void)?

    private let queue = DispatchQueue(label: "genesis.live-recording.rpc")
    private let callbackQueue: DispatchQueue
    private var descriptor: Int32 = -1
    private var source: DispatchSourceRead?
    private var buffer: [UInt8] = []
    private let idLock = NSLock()
    private var nextID = 1
    private var pending: [Int: (Result<Any?, Error>) -> Void] = [:]
    private var progressHandlers: [Int: (CallProgress) -> Void] = [:]
    /// Each waiting call's deadline. A `$/progress` for the call starts it again (as the TypeScript side does), so a
    /// timer armed before that step finds a newer generation and does nothing.
    private struct Deadline {
        let method: String
        let timeout: TimeInterval
        var generation = 0
    }

    private var deadlines: [Int: Deadline] = [:]
    private var handlers: [String: Handler] = [:]
    /// The peer's requests still waiting for their answer, by `key(of:)` of their id.
    private var incoming: [String: Incoming] = [:]
    private var closed = false

    public init(path: String, callbackQueue: DispatchQueue = .main) {
        self.path = path
        self.callbackQueue = callbackQueue
    }

    deinit {
        if descriptor >= 0 { source?.cancel() }
    }

    /// Synchronous: a Unix socket connects or refuses at once.
    public func connect() throws {
        try queue.sync {
            guard descriptor < 0 else { return }
            var address = sockaddr_un()
            address.sun_family = sa_family_t(AF_UNIX)
            let bytes = Array(path.utf8)
            guard bytes.count < MemoryLayout.size(ofValue: address.sun_path) else { throw Failure.pathTooLong }
            withUnsafeMutableBytes(of: &address.sun_path) { raw in
                raw.copyBytes(from: bytes)
                raw[bytes.count] = 0
            }
            address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)

            let socketFD = socket(AF_UNIX, SOCK_STREAM, 0)
            guard socketFD >= 0 else { throw Failure.connect(errno: errno) }
            var noSigpipe: Int32 = 1
            setsockopt(socketFD, SOL_SOCKET, SO_NOSIGPIPE, &noSigpipe, socklen_t(MemoryLayout<Int32>.size))
            let result = withUnsafePointer(to: &address) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    Darwin.connect(socketFD, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
                }
            }
            guard result == 0 else {
                let code = errno
                Darwin.close(socketFD)
                throw Failure.connect(errno: code)
            }

            descriptor = socketFD
            let source = DispatchSource.makeReadSource(fileDescriptor: socketFD, queue: queue)
            source.setEventHandler { [weak self] in self?.readAvailable() }
            source.setCancelHandler { Darwin.close(socketFD) }
            source.resume()
            self.source = source
        }
    }

    public func close() {
        queue.async { self.shutDown(notify: false) }
    }

    public func call(_ method: String, params: [String: Any]? = nil, timeout: TimeInterval = 3,
                     completion: @escaping (Result<Any?, Error>) -> Void) {
        request(method, params: params, timeout: timeout, completion: completion)
    }

    /// `call` with the request id, which `cancel(_:)` takes, and the peer's `$/progress` for it on `onProgress`.
    @discardableResult
    public func request(_ method: String, params: [String: Any]? = nil, timeout: TimeInterval = 3,
                        onProgress: ((CallProgress) -> Void)? = nil,
                        completion: @escaping (Result<Any?, Error>) -> Void) -> Int {
        idLock.lock()
        let id = nextID
        nextID += 1
        idLock.unlock()
        queue.async {
            guard self.descriptor >= 0, !self.closed else {
                self.deliver(completion, .failure(Failure.notConnected))
                return
            }

            var message: [String: Any] = ["jsonrpc": "2.0", "id": id, "method": method]
            if let params { message["params"] = params }
            guard let data = Self.encode(message) else {
                self.deliver(completion, .failure(Failure.badMessage))
                return
            }

            self.pending[id] = completion
            if let onProgress { self.progressHandlers[id] = onProgress }
            guard self.writeAll(data) else {
                self.shutDown(notify: true)
                return
            }

            self.deadlines[id] = Deadline(method: method, timeout: timeout)
            self.armDeadline(id)
        }
        return id
    }

    /// Fails the call when its deadline passes with no answer and no newer step.
    private func armDeadline(_ id: Int) {
        guard let deadline = deadlines[id] else { return }
        queue.asyncAfter(deadline: .now() + deadline.timeout) {
            guard self.deadlines[id]?.generation == deadline.generation,
                  let waiting = self.pending.removeValue(forKey: id) else { return }
            self.deadlines[id] = nil
            self.progressHandlers[id] = nil
            self.deliver(waiting, .failure(Failure.timeout(method: deadline.method)))
        }
    }

    /// Asks the peer to stop a call still waiting (`$/cancel { id }`); its answer (error 1013) ends the call.
    public func cancel(_ id: Int) {
        queue.async {
            guard self.pending[id] != nil else { return }
            self.send(["jsonrpc": "2.0", "method": "$/cancel", "params": ["id": id]])
        }
    }

    /// Sends a notification (a message with no id); dropped while not connected.
    public func notify(_ method: String, params: [String: Any]? = nil) {
        queue.async {
            var message: [String: Any] = ["jsonrpc": "2.0", "method": method]
            if let params { message["params"] = params }
            self.send(message)
        }
    }

    /// Registers the handler that answers the peer's `method` requests; a later one for the same name replaces it.
    public func answer(_ method: String, with handler: @escaping Handler) {
        queue.sync { handlers[method] = handler }
    }

    /// The methods this side answers, sorted: what a `hello` lists.
    public var answers: [String] {
        queue.sync { handlers.keys.sorted() }
    }

    public func call(_ method: String, params: [String: Any]? = nil, timeout: TimeInterval = 3) async throws -> Any? {
        try await withCheckedThrowingContinuation { continuation in
            call(method, params: params, timeout: timeout) { continuation.resume(with: $0) }
        }
    }

    // MARK: - Socket queue

    private func writeAll(_ bytes: [UInt8]) -> Bool {
        var offset = 0
        while offset < bytes.count {
            let written = bytes[offset...].withUnsafeBytes { write(descriptor, $0.baseAddress, $0.count) }
            if written < 0, errno == EINTR { continue }
            guard written > 0 else { return false }
            offset += written
        }

        return true
    }

    private func readAvailable() {
        var chunk = [UInt8](repeating: 0, count: 65_536)
        let count = read(descriptor, &chunk, chunk.count)
        guard count > 0 else {
            shutDown(notify: true)
            return
        }

        buffer.append(contentsOf: chunk[0..<count])
        while let newline = buffer.firstIndex(of: 10) {
            let line = Array(buffer[..<newline])
            buffer.removeSubrange(...newline)
            handle(line)
        }
    }

    private func handle(_ line: [UInt8]) {
        guard !line.isEmpty, let object = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any] else {
            return
        }

        if let id = (object["id"] as? NSNumber)?.intValue, object["method"] == nil {
            progressHandlers[id] = nil
            deadlines[id] = nil
            guard let waiting = pending.removeValue(forKey: id) else { return }
            if let error = object["error"] as? [String: Any] {
                let failure = Failure.remote(code: (error["code"] as? NSNumber)?.intValue ?? 0,
                                             message: error["message"] as? String ?? "the recorder refused")
                deliver(waiting, .failure(failure))
            } else {
                deliver(waiting, .success(object["result"].flatMap { $0 is NSNull ? nil : $0 }))
            }
            return
        }

        if let method = object["method"] as? String, let id = object["id"], !(id is NSNull) {
            receive(method: method, id: id, params: object["params"])
            return
        }

        if let method = object["method"] as? String, object["id"] == nil {
            let params = object["params"]
            switch method {
            case "$/progress": progressArrived(params as? [String: Any])
            case "$/cancel": cancelIncoming((params as? [String: Any])?["id"])
            default: callbackQueue.async { self.onNotification?(method, params) }
            }
        }
    }

    // MARK: - The peer's requests (socket queue)

    /// A request id as a key: a number and a string with the same digits are different ids.
    private static func key(of id: Any?) -> String? {
        switch id {
        case let number as NSNumber: return "n:\(number.stringValue)"
        case let text as String: return "s:\(text)"
        default: return nil
        }
    }

    private func receive(method: String, id: Any, params: Any?) {
        guard let key = Self.key(of: id) else {
            reply(id: id, error: (Code.invalidRequest, "a request id must be a number or a string"))
            return
        }
        guard incoming[key] == nil else {
            reply(id: id, error: (Code.invalidRequest, "request \(id) is still being answered"))
            return
        }
        guard let handler = handlers[method] else {
            reply(id: id, error: (Code.methodNotFound, "\(method) is not a method this side answers"))
            return
        }

        let request = Incoming(method: method, params: params, id: id, key: key, client: self)
        incoming[key] = request
        callbackQueue.async {
            handler(request) { result in
                self.queue.async { self.finish(request, result) }
            }
        }
    }

    private func finish(_ request: Incoming, _ result: Result<Any?, Error>) {
        // Gone when the peer cancelled it (answered 1013 then) or the connection ended: the late answer is dropped.
        guard incoming[request.key] === request else { return }
        incoming[request.key] = nil
        switch result {
        case let .success(value):
            guard let data = Self.encode(["jsonrpc": "2.0", "id": request.id, "result": value ?? NSNull()]) else {
                reply(id: request.id, error: (Code.internalError, "the answer to \(request.method) is not JSON"))
                return
            }
            if descriptor >= 0, !closed, !writeAll(data) { shutDown(notify: true) }
        case let .failure(error):
            reply(id: request.id, error: Self.coded(error))
        }
    }

    private static func coded(_ error: Error) -> (Int, String) {
        switch error {
        case let Failure.remote(code, message): return (code, message)
        case is CancellationError: return (Code.cancelled, "cancelled")
        default: return (Code.internalError, error.localizedDescription)
        }
    }

    private func cancelIncoming(_ id: Any?) {
        guard let key = Self.key(of: id), let request = incoming.removeValue(forKey: key) else { return }
        reply(id: request.id, error: (Code.cancelled, "\(request.method) was cancelled"))
        request.markCancelled(on: callbackQueue)
    }

    fileprivate func sendProgress(for request: Incoming, fraction: Double?, label: String?) {
        queue.async {
            guard self.incoming[request.key] === request else { return }
            var params: [String: Any] = ["id": request.id]
            if let fraction, fraction.isFinite { params["fraction"] = fraction }
            if let label { params["label"] = label }
            self.send(["jsonrpc": "2.0", "method": "$/progress", "params": params])
        }
    }

    private func progressArrived(_ params: [String: Any]?) {
        guard let id = (params?["id"] as? NSNumber)?.intValue else { return }
        if var deadline = deadlines[id] {
            deadline.generation += 1
            deadlines[id] = deadline
            armDeadline(id)
        }
        guard let handler = progressHandlers[id] else { return }
        let step = CallProgress(fraction: (params?["fraction"] as? NSNumber)?.doubleValue, label: params?["label"] as? String)
        callbackQueue.async { handler(step) }
    }

    private func reply(id: Any, error: (code: Int, message: String)) {
        send(["jsonrpc": "2.0", "id": id, "error": ["code": error.code, "message": error.message]])
    }

    /// Writes one message; a failed write ends the connection.
    private func send(_ message: [String: Any]) {
        guard descriptor >= 0, !closed, let data = Self.encode(message) else { return }
        if !writeAll(data) { shutDown(notify: true) }
    }

    private static func encode(_ message: [String: Any]) -> [UInt8]? {
        guard JSONSerialization.isValidJSONObject(message),
              let data = try? JSONSerialization.data(withJSONObject: message) else { return nil }
        return Array(data) + [10]
    }

    private func deliver(_ completion: @escaping (Result<Any?, Error>) -> Void, _ result: Result<Any?, Error>) {
        callbackQueue.async { completion(result) }
    }

    private func shutDown(notify: Bool) {
        guard !closed else { return }
        closed = true
        source?.cancel()
        source = nil
        descriptor = -1
        let waiting = pending.values
        pending = [:]
        progressHandlers = [:]
        deadlines = [:]
        for completion in waiting {
            deliver(completion, .failure(Failure.closed))
        }
        // Nobody is left to answer: the peer's open requests are cancelled.
        let open = incoming.values
        incoming = [:]
        for request in open {
            request.markCancelled(on: callbackQueue)
        }

        if notify { callbackQueue.async { self.onClose?() } }
    }
}
