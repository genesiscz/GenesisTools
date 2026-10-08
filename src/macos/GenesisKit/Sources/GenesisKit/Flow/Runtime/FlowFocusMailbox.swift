import CryptoKit
import Foundation

/// File-backed commands with the existing native faces' distributed-notification wakeup.
/// The directory is private to this login user. Notifications contain no transcript or payload.
/// FSEvents is the fallback when a notification is coalesced or arrives before an atomic rename.
@MainActor
public final class FlowFocusMailbox {
    public struct Command: Codable, Sendable {
        public let id: UUID
        public let ownerNonce: UUID
        public let action: String
        public let payload: Data
        public let createdAt: Date
        public let expiresAt: Date
        public let sequence: UInt64
    }

    private struct Reply: Codable {
        let id: UUID
        let ownerNonce: UUID
        let result: Data?
        let error: String?
    }

    public enum Failure: LocalizedError {
        case unavailable(String)
        public var errorDescription: String? {
            switch self { case .unavailable(let message): return message }
        }
    }

    public var onStateChange: (() -> Void)?
    public var onOwnerChange: (() -> Void)?
    public let directory: URL
    public let owner: FlowFocusLease.Owner
    private let handler: ((Command) throws -> Data)?
    private let requests: URL
    private let replies: URL
    private let wakeName: Notification.Name
    private var watcher: DirectoryWatcher?
    private var observer: NSObjectProtocol?
    private var pending: [UUID: CheckedContinuation<Data, Error>] = [:]
    private var deadlines: [UUID: Task<Void, Never>] = [:]
    private var isDraining = false
    private var stopped = false
    private var completed: [UUID] = []
    private var processed = Set<UUID>()
    private var replyCache: [UUID: Reply] = [:]
    private var sequence: UInt64 = 0

    public init(directory: URL, owner: FlowFocusLease.Owner,
                handler: ((Command) throws -> Data)? = nil) throws {
        self.directory = directory
        self.owner = owner
        self.handler = handler
        requests = directory.appendingPathComponent("requests", isDirectory: true)
        replies = directory.appendingPathComponent("replies", isDirectory: true)
        let hash = SHA256.hash(data: Data(directory.standardizedFileURL.path.utf8))
            .prefix(12).map { String(format: "%02x", $0) }.joined()
        wakeName = Notification.Name("dev.genesis.flow-focus.\(hash)")
        if handler != nil {
            for folder in [requests, replies] {
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true,
                                                        attributes: [.posixPermissions: 0o700])
            }
        }
    }

    public func start() {
        guard watcher == nil, !stopped else { return }
        watcher = DirectoryWatcher(paths: [directory.path], latency: 0.1) { [weak self] _ in
            MainActor.assumeIsolated { self?.receive() }
        }
        observer = DistributedNotificationCenter.default().addObserver(
            forName: wakeName, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.receive() }
        }
        receive()
    }

    public func stop() {
        stopped = true
        watcher?.stop()
        watcher = nil
        if let observer { DistributedNotificationCenter.default().removeObserver(observer) }
        observer = nil
        let continuations = pending.values
        pending.removeAll()
        for task in deadlines.values { task.cancel() }
        deadlines.removeAll()
        for continuation in continuations { continuation.resume(throwing: CancellationError()) }
    }

    /// A repeated ID in the same ownership epoch returns its saved reply. A request from a
    /// previous owner is refused, so a delayed client cannot mutate a replacement's state.
    public func request(action: String, payload: Data = Data(), id: UUID = UUID(),
                        timeout: TimeInterval = 5) async throws -> Data {
        guard !stopped else { throw Failure.unavailable("Flow and Focus have stopped.") }
        guard payload.count <= 4 * 1_024 * 1_024 else {
            throw Failure.unavailable("This Flow and Focus command is too large.")
        }
        sequence &+= 1
        let wait = max(0.1, min(timeout, 30))
        let command = Command(id: id, ownerNonce: owner.nonce, action: action, payload: payload,
                              createdAt: Date(), expiresAt: Date().addingTimeInterval(wait), sequence: sequence)
        if handler != nil {
            return try unwrap(execute(command))
        }
        guard pending[id] == nil else { throw Failure.unavailable("That command is already pending.") }
        guard let current = try? FlowFocusLease.readOwner(directory: directory), current.nonce == owner.nonce else {
            onOwnerChange?()
            throw Failure.unavailable("The Flow and Focus owner changed. Try the action again.")
        }
        if let reply = readReply(id), reply.ownerNonce == owner.nonce { return try unwrap(reply) }
        try FlowFocusLease.writePrivate(try JSONEncoder().encode(command), to: requestURL(id))
        return try await withCheckedThrowingContinuation { continuation in
            pending[id] = continuation
            deadlines[id] = Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
                guard !Task.isCancelled, let self, let pending = self.pending.removeValue(forKey: id) else { return }
                self.deadlines.removeValue(forKey: id)
                pending.resume(throwing: Failure.unavailable("The Flow and Focus owner did not answer in time."))
            }
            wake()
            receiveReplies()
        }
    }

    public func signalStateChange() { wake() }

    private func receive() {
        guard !stopped else { return }
        if handler != nil { drain() }
        receiveReplies()
        onStateChange?()
        if let current = try? FlowFocusLease.readOwner(directory: directory), current.nonce == owner.nonce {
            return
        }
        onOwnerChange?()
    }

    private func drain() {
        guard !isDraining else { return }
        isDraining = true
        defer { isDraining = false }
        do {
            let files = try FileManager.default.contentsOfDirectory(at: requests, includingPropertiesForKeys: nil)
                .filter { $0.pathExtension == "json" }
            var commands: [(URL, Command)] = []
            for file in files.prefix(128) {
                do {
                    let data = try Data(contentsOf: file, options: .mappedIfSafe)
                    guard data.count <= 6 * 1_024 * 1_024 else {
                        throw Failure.unavailable("Oversized runtime command")
                    }
                    let command = try JSONDecoder().decode(Command.self, from: data)
                    commands.append((file, command))
                } catch {
                    FlowFocusLog.focus.error("runtime command failed: \(error.localizedDescription)")
                    // Invalid input is quarantined once, never retried on every file event.
                    let bad = file.appendingPathExtension("rejected")
                    do { try FileManager.default.moveItem(at: file, to: bad) }
                    catch { FlowFocusLog.focus.error("runtime quarantine failed: \(error.localizedDescription)") }
                }
            }
            commands.sort {
                if $0.1.createdAt != $1.1.createdAt { return $0.1.createdAt < $1.1.createdAt }
                return $0.1.sequence < $1.1.sequence
            }
            for (file, command) in commands {
                _ = execute(command)
                do { try FileManager.default.removeItem(at: file) }
                catch { FlowFocusLog.focus.error("runtime queue cleanup failed: \(error.localizedDescription)") }
            }
            if files.count > 128 { Task { @MainActor [weak self] in self?.drain() } }
        } catch {
            FlowFocusLog.focus.error("runtime queue read failed: \(error.localizedDescription)")
        }
    }

    private func execute(_ command: Command) -> Reply {
        if let prior = replyCache[command.id] ?? readReply(command.id), prior.ownerNonce == command.ownerNonce {
            return prior
        }
        let reply: Reply
        do {
            guard command.ownerNonce == owner.nonce, let handler else {
                throw Failure.unavailable("This command belongs to an expired Flow and Focus owner.")
            }
            guard !processed.contains(command.id) else {
                throw Failure.unavailable("That command already ran; its saved reply has expired.")
            }
            guard command.expiresAt > Date() else {
                throw Failure.unavailable("That command timed out before the owner could run it.")
            }
            processed.insert(command.id)
            let result = try handler(command)
            reply = Reply(id: command.id, ownerNonce: command.ownerNonce, result: result, error: nil)
        } catch {
            reply = Reply(id: command.id, ownerNonce: command.ownerNonce, result: nil, error: error.localizedDescription)
        }
        do {
            replyCache[command.id] = reply
            try FlowFocusLease.writePrivate(try JSONEncoder().encode(reply), to: replyURL(command.id))
            completed.append(command.id)
            if completed.count > 256 {
                let expired = completed.removeFirst()
                replyCache.removeValue(forKey: expired)
                try FileManager.default.removeItem(at: replyURL(expired))
            }
        } catch {
            FlowFocusLog.focus.error("runtime reply write failed: \(error.localizedDescription)")
        }
        wake()
        return reply
    }

    private func receiveReplies() {
        for id in Array(pending.keys) {
            guard let reply = readReply(id), reply.ownerNonce == owner.nonce,
                  let continuation = pending.removeValue(forKey: id) else { continue }
            deadlines.removeValue(forKey: id)?.cancel()
            do { continuation.resume(returning: try unwrap(reply)) }
            catch { continuation.resume(throwing: error) }
        }
    }

    private func unwrap(_ reply: Reply) throws -> Data {
        if let error = reply.error { throw Failure.unavailable(error) }
        return reply.result ?? Data()
    }

    private func readReply(_ id: UUID) -> Reply? {
        guard let data = try? Data(contentsOf: replyURL(id)) else { return nil }
        return try? JSONDecoder().decode(Reply.self, from: data)
    }

    private func requestURL(_ id: UUID) -> URL { requests.appendingPathComponent("\(id.uuidString).json") }
    private func replyURL(_ id: UUID) -> URL { replies.appendingPathComponent("\(id.uuidString).json") }

    private func wake() {
        DistributedNotificationCenter.default().postNotificationName(wakeName, object: nil,
                                                                      userInfo: nil, deliverImmediately: true)
    }
}
