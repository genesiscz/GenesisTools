import CoreServices
import Foundation

/// One FSEvents stream over a set of folders, delivered on the main queue. The stream's own latency
/// coalesces a burst of writes into one callback; `accepts` drops paths that do not matter (a file
/// written in a watched tree beside the one you care about). A folder that does not exist yet is fine:
/// FSEvents watches the path and reports it once something creates it.
///
/// The stream holds a retained box with a weak reference, never the watcher itself, so an event
/// queued after the watcher is gone finds nil instead of freed memory.
public final class DirectoryWatcher {
    private final class Box {
        weak var watcher: DirectoryWatcher?

        init(_ watcher: DirectoryWatcher) {
            self.watcher = watcher
        }
    }

    public let paths: [String]
    private var stream: FSEventStreamRef?
    private let accepts: (String) -> Bool
    private let onChange: ([String]) -> Void

    /// `latency` in seconds: FSEvents holds events this long and hands them over as one batch.
    /// `onChange` gets the accepted paths of one batch; it runs on the main queue.
    public init(paths: [String], latency: TimeInterval = 0.5, accepts: @escaping (String) -> Bool = { _ in true }, onChange: @escaping ([String]) -> Void) {
        self.paths = paths
        self.accepts = accepts
        self.onChange = onChange
        guard !paths.isEmpty else { return }
        var context = FSEventStreamContext(
            version: 0,
            info: Unmanaged.passRetained(Box(self)).toOpaque(),
            retain: nil,
            release: { info in
                if let info {
                    Unmanaged<Box>.fromOpaque(info).release()
                }
            },
            copyDescription: nil
        )
        let callback: FSEventStreamCallback = { _, info, count, rawPaths, _, _ in
            guard let info, let watcher = Unmanaged<Box>.fromOpaque(info).takeUnretainedValue().watcher else { return }
            let list = (unsafeBitCast(rawPaths, to: NSArray.self) as? [String] ?? []).prefix(count)
            let accepted = list.filter(watcher.accepts)
            if !accepted.isEmpty {
                watcher.onChange(Array(accepted))
            }
        }
        stream = FSEventStreamCreate(
            nil,
            callback,
            &context,
            paths as CFArray,
            FSEventStreamEventId(kFSEventStreamEventIdSinceNow),
            max(0.1, latency),
            FSEventStreamCreateFlags(kFSEventStreamCreateFlagUseCFTypes | kFSEventStreamCreateFlagFileEvents)
        )
        if let stream {
            FSEventStreamSetDispatchQueue(stream, DispatchQueue.main)
            FSEventStreamStart(stream)
        }
    }

    public func stop() {
        guard let stream else { return }
        FSEventStreamStop(stream)
        FSEventStreamInvalidate(stream)
        FSEventStreamRelease(stream)
        self.stream = nil
    }

    deinit {
        stop()
    }
}
