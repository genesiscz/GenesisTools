import Foundation

/// One process of a kind per login session (GenesisTools: the hub, the markdown viewer). The holder keeps an
/// exclusive `flock` on `lockFile` for its whole life; the kernel drops it when the process ends, crash included,
/// so a stale claim is impossible. A later launch that cannot take the lock hands its arguments to the holder (a
/// distributed notification, answered within `ackTimeout`) and exits, so two launches never open two windows, even
/// when both start at the same moment.
public final class SingleInstance: @unchecked Sendable {
    /// The kind in log lines and messages ("hub").
    public let name: String
    private let lockFile: URL
    private let request: Notification.Name
    private let ack: Notification.Name
    /// What the user does when the holder never answers ("quit that one, then run tools hub again.").
    private let retryHint: String
    private let log: (String) -> Void
    private let ackTimeout: TimeInterval = 1.5
    /// The holder may still be starting (a hub serves right after its window exists, ~0.5 s in).
    private let forwardAttempts = 3
    private var lockDescriptor: Int32 = -1
    /// A read-only handle on the lock file for `isRunningElsewhere`, opened on its first call.
    private var probeDescriptor: Int32 = -1

    /// `notificationPrefix` names the two distributed notifications (`<prefix>.request`, `<prefix>.ack`).
    public init(name: String, lockFile: URL, notificationPrefix: String, retryHint: String, log: @escaping (String) -> Void) {
        self.name = name
        self.lockFile = lockFile
        request = Notification.Name(notificationPrefix + ".request")
        ack = Notification.Name(notificationPrefix + ".ack")
        self.retryHint = retryHint
        self.log = log
    }

    /// True when this process is now THE one. Call once, before the window is built.
    public func claim() -> Bool {
        try? FileManager.default.createDirectory(at: lockFile.deletingLastPathComponent(), withIntermediateDirectories: true)
        let descriptor = open(lockFile.path, O_RDWR | O_CREAT | O_CLOEXEC, 0o644)
        guard descriptor >= 0 else {
            // Without a lock file the guarantee cannot hold; a second window is better than none.
            log("singleInstance: \(name) lock file not opened (errno \(errno)); running without the one-\(name) guarantee")
            return true
        }
        guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
            close(descriptor)
            return false
        }
        lockDescriptor = descriptor
        // The pid is only for the message a later launch prints when this one does not answer.
        let pid = "\(getpid())\n"
        if ftruncate(descriptor, 0) != 0 || pid.withCString({ write(descriptor, $0, strlen($0)) }) < 0 {
            log("singleInstance: pid not written to the \(name) lock file (errno \(errno))")
        }
        return true
    }

    /// Another process holds the lock, so one runs there. Asks the kernel, not the pid file, which outlives
    /// the process that wrote it.
    /// The lock file is opened once and kept: a dock timer asks this on the main thread every few seconds, and an
    /// `open` there waited 0.5 to 2.2 s per call while the disk was nearly full (review window, 2026-10-27).
    public var isRunningElsewhere: Bool {
        guard lockDescriptor < 0 else { return false }
        if probeDescriptor < 0 {
            probeDescriptor = open(lockFile.path, O_RDONLY | O_CLOEXEC)
        }
        guard probeDescriptor >= 0 else { return false }
        guard flock(probeDescriptor, LOCK_SH | LOCK_NB) == 0 else { return true }
        // Held, this shared lock would refuse a later launch its exclusive claim.
        flock(probeDescriptor, LOCK_UN)
        return false
    }

    /// The pid the lock holder wrote, while that process runs.
    private var holderPid: pid_t? {
        guard let text = try? String(contentsOf: lockFile, encoding: .utf8),
              let pid = pid_t(text.trimmingCharacters(in: .whitespacesAndNewlines)), pid != getpid(), kill(pid, 0) == 0
        else { return nil }
        return pid
    }

    /// Hands `args` to the process that holds the lock. True when it answered. False when it never did (busy or
    /// hung): the caller still exits, since a second window would break the one-window rule for as long as the
    /// first one lives, and says how to get a working one back.
    public func forward(_ args: [String]) -> Bool {
        for attempt in 1...forwardAttempts {
            if post(args) {
                log("singleInstance: handed \(args) to the running \(name) (attempt \(attempt))")
                return true
            }
        }
        let holder = holderPid.map { "\(name) (pid \($0))" } ?? name
        let waited = Int(ackTimeout * Double(forwardAttempts))
        let message = "The running \(holder) did not answer in \(waited) s; it may be busy or hung. Not opening a second \(name): \(retryHint)"
        log("singleInstance: \(message)")
        FileHandle.standardError.write(Data("\(message)\n".utf8))
        return false
    }

    /// For a window that is already running: post the request and go on. `forward` waits for the answer in a
    /// nested run loop, which froze a review window for 4.5 s while the hub was busy (stall 2026-10-08 01:50);
    /// the holder applies the request when it is free.
    public func handOff(_ args: [String]) {
        DistributedNotificationCenter.default().postNotificationName(
            request, object: UUID().uuidString, userInfo: ["args": args], deliverImmediately: true
        )
        log("singleInstance: handed \(args) to the running \(name), not waiting for its answer")
    }

    private func post(_ args: [String]) -> Bool {
        let token = UUID().uuidString
        var answered = false
        let center = DistributedNotificationCenter.default()
        let observer = center.addObserver(forName: ack, object: token, queue: nil) { _ in answered = true }
        defer { center.removeObserver(observer) }
        center.postNotificationName(request, object: token, userInfo: ["args": args], deliverImmediately: true)

        // The observer is a run loop source, so each run blocks until the reply or the deadline.
        let deadline = Date().addingTimeInterval(ackTimeout)
        while !answered, Date() < deadline {
            if CFRunLoopRunInMode(.defaultMode, deadline.timeIntervalSinceNow, true) == .finished {
                break
            }
        }
        return answered
    }

    /// Called by the process that holds the lock: applies every later launch's arguments.
    public func serve(_ apply: @escaping ([String]) -> Void) {
        let center = DistributedNotificationCenter.default()
        // `.deliverImmediately` on the post is not enough for an app in the background: its own
        // suspension behaviour must let the request through as well.
        center.suspended = false
        center.addObserver(forName: request, object: nil, queue: .main) { [log, name, ack] note in
            let args = note.userInfo?["args"] as? [String] ?? []
            log("singleInstance: \(name) request \(args)")
            apply(args)
            center.postNotificationName(ack, object: note.object as? String, userInfo: nil, deliverImmediately: true)
        }
    }
}
