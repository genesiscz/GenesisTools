import Darwin
import Foundation

/// A JSON-RPC 2.0 client over a Unix domain socket, one JSON message per line: the control channel of a live
/// recording. Calls carry an id and a timeout; a message with a `method` and no `id` is a notification. All socket work
/// runs on one private queue; results, notifications and the close arrive on `callbackQueue`.
public final class LiveRecordingRPCClient: @unchecked Sendable {
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
    private var nextID = 1
    private var pending: [Int: (Result<Any?, Error>) -> Void] = [:]
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
        queue.async {
            guard self.descriptor >= 0, !self.closed else {
                self.deliver(completion, .failure(Failure.notConnected))
                return
            }

            let id = self.nextID
            self.nextID += 1
            var message: [String: Any] = ["jsonrpc": "2.0", "id": id, "method": method]
            if let params { message["params"] = params }
            guard JSONSerialization.isValidJSONObject(message),
                  let data = try? JSONSerialization.data(withJSONObject: message)
            else {
                self.deliver(completion, .failure(Failure.badMessage))
                return
            }

            self.pending[id] = completion
            guard self.writeAll(Array(data) + [10]) else {
                self.shutDown(notify: true)
                return
            }

            self.queue.asyncAfter(deadline: .now() + timeout) {
                if let waiting = self.pending.removeValue(forKey: id) {
                    self.deliver(waiting, .failure(Failure.timeout(method: method)))
                }
            }
        }
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

        if let method = object["method"] as? String, object["id"] == nil {
            let params = object["params"]
            callbackQueue.async { self.onNotification?(method, params) }
        }
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
        for completion in waiting {
            deliver(completion, .failure(Failure.closed))
        }

        if notify { callbackQueue.async { self.onClose?() } }
    }
}
