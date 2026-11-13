import CoreServices
import Foundation

/// One FSEvents stream over a set of folders, delivered on the main queue. The stream's own latency
/// coalesces a burst of writes into one callback; `accepts` drops paths that do not matter (a file
/// written in a watched tree beside the one you care about). A folder that does not exist yet is fine:
/// FSEvents watches the path and reports it once something creates it.
///
/// The native cleanup owns the callback box until the stream is released. Delivery keeps only a weak
/// reference to its owner, and stop cancels queued main-thread callbacks before asynchronous cleanup.
public final class DirectoryWatcher {
    /// Runs on the stream's serial queue and returns the cleanup to run on that same queue.
    package typealias StartStream = (DispatchQueue, FSEventStreamEventId, @escaping ([String]) -> Void) -> (() -> Void)

    public let paths: [String]
    private let owner: StreamOwner

    /// `onChange` and `accepts` run on main. Native registration, reconnection and cleanup do not.
    public init(paths: [String], latency: TimeInterval = 0.5, fileEvents: Bool = true,
                accepts: @escaping (String) -> Bool = { _ in true }, onChange: @escaping ([String]) -> Void) {
        self.paths = paths
        owner = StreamOwner(accepts: accepts, onChange: onChange)
        guard !paths.isEmpty else { return }
        // Preserve events written before asynchronous registration finishes.
        let since = FSEventsGetCurrentEventId()
        owner.start(since: since) { queue, since, receive in
            Self.startNative(paths: paths, latency: latency, fileEvents: fileEvents,
                             queue: queue, since: since, receive: receive)
        }
    }

    /// A controlled native boundary for lifecycle and callback tests.
    package init(paths: [String], since: FSEventStreamEventId, start: @escaping StartStream,
                 accepts: @escaping (String) -> Bool = { _ in true }, onChange: @escaping ([String]) -> Void) {
        self.paths = paths
        owner = StreamOwner(accepts: accepts, onChange: onChange)
        if !paths.isEmpty { owner.start(since: since, native: start) }
    }

    private final class CallbackBox {
        let receive: ([String]) -> Void
        init(_ receive: @escaping ([String]) -> Void) { self.receive = receive }
    }

    private static func startNative(paths: [String], latency: TimeInterval, fileEvents: Bool,
                                    queue: DispatchQueue, since: FSEventStreamEventId,
                                    receive: @escaping ([String]) -> Void) -> () -> Void {
        let box = CallbackBox(receive)
        // The cleanup closure owns the box until the stream is invalidated and released.
        var context = FSEventStreamContext(version: 0, info: Unmanaged.passUnretained(box).toOpaque(),
                                           retain: nil, release: nil, copyDescription: nil)
        let callback: FSEventStreamCallback = { _, info, count, rawPaths, _, _ in
            guard let info else { return }
            let box = Unmanaged<CallbackBox>.fromOpaque(info).takeUnretainedValue()
            let paths = Array((unsafeBitCast(rawPaths, to: NSArray.self) as? [String] ?? []).prefix(count))
            box.receive(paths)
        }
        guard let stream = FSEventStreamCreate(nil, callback, &context, paths as CFArray, since, max(0.1, latency),
                                               FSEventStreamCreateFlags(kFSEventStreamCreateFlagUseCFTypes
                                                   | (fileEvents ? kFSEventStreamCreateFlagFileEvents : 0))) else { return {} }
        FSEventStreamSetDispatchQueue(stream, queue)
        let cleanup = {
            withExtendedLifetime(box) {
                FSEventStreamStop(stream)
                FSEventStreamInvalidate(stream)
                FSEventStreamRelease(stream)
            }
        }
        guard FSEventStreamStart(stream) else {
            withExtendedLifetime(box) {
                FSEventStreamInvalidate(stream)
                FSEventStreamRelease(stream)
            }
            return {}
        }
        return cleanup
    }

    /// Only the stream queue owns its native cleanup. The lock fences delivery against stop, including a stop
    /// made from inside a callback. Callers do not wait for native registration or teardown to finish.
    private final class StreamOwner: @unchecked Sendable {
        private let queue = DispatchQueue(label: "genesis.directory-watcher", qos: .utility)
        private let lock = NSRecursiveLock()
        private var stopped = false
        private var cleanup: (() -> Void)?
        private let accepts: (String) -> Bool
        private let onChange: ([String]) -> Void

        init(accepts: @escaping (String) -> Bool, onChange: @escaping ([String]) -> Void) {
            self.accepts = accepts
            self.onChange = onChange
        }

        private var isStopped: Bool {
            lock.lock(); defer { lock.unlock() }
            return stopped
        }

        func start(since: FSEventStreamEventId, native: @escaping StartStream) {
            queue.async { [self] in
                guard !isStopped else { return }
                let stop = native(queue, since) { [weak self] paths in self?.receive(paths) }
                if isStopped { stop() } else { cleanup = stop }
            }
        }

        private func receive(_ paths: [String]) {
            let normalized = paths.map(DirectoryWatcher.normalizedEventPath)
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                lock.lock(); defer { lock.unlock() }
                guard !stopped else { return }
                let accepted = normalized.filter(accepts)
                if !stopped, !accepted.isEmpty { onChange(accepted) }
            }
        }

        func stop() {
            lock.lock()
            guard !stopped else { lock.unlock(); return }
            stopped = true
            lock.unlock()
            queue.async { [self] in
                cleanup?()
                cleanup = nil
            }
        }
    }

    // FSEvents uses /private aliases that Foundation file URLs collapse. Normalize without statting each path.
    public static func normalizedEventPath(_ path: String) -> String {
        if path == "/private/var" || path.hasPrefix("/private/var/")
            || path == "/private/tmp" || path.hasPrefix("/private/tmp/") {
            return String(path.dropFirst("/private".count))
        }
        return path
    }

    public func stop() { owner.stop() }
    deinit { owner.stop() }
}
