import AppKit
import Foundation

/// One hub per login session. The hub holds an exclusive `flock` on `~/.genesis-tools/hub/hub.lock`
/// for its whole life; the kernel drops it when the process ends, crash included, so a stale claim is
/// impossible. A later `GenesisTools --hub` that cannot take the lock hands its arguments to the
/// holder (a distributed notification, answered within `ackTimeout`) and exits, so `tools hub` twice
/// never opens two windows, even when both launches start at the same moment.
enum HubSingleInstance {
    private static let request = Notification.Name("com.genesiscz.genesistools.hub.request")
    private static let ack = Notification.Name("com.genesiscz.genesistools.hub.ack")
    private static let ackTimeout: TimeInterval = 1.5
    /// The holder may still be starting (it serves right after its window exists, ~0.5 s in).
    private static let forwardAttempts = 3
    private nonisolated(unsafe) static var lockDescriptor: Int32 = -1

    private static var lockFile: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".genesis-tools/hub/hub.lock")
    }

    /// True when this process is now THE hub. Call once, before the window is built.
    static func claim() -> Bool {
        try? FileManager.default.createDirectory(at: lockFile.deletingLastPathComponent(), withIntermediateDirectories: true)
        let descriptor = open(lockFile.path, O_RDWR | O_CREAT | O_CLOEXEC, 0o644)
        guard descriptor >= 0 else {
            // Without a lock file the guarantee cannot hold; a second window is better than none.
            HubPerf.log("singleInstance: lock file not opened (errno \(errno)); running without the one-hub guarantee")
            return true
        }
        guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
            close(descriptor)
            return false
        }
        lockDescriptor = descriptor
        // The pid is only for the message a later launch prints when this hub does not answer.
        let pid = "\(getpid())\n"
        if ftruncate(descriptor, 0) != 0 || pid.withCString({ write(descriptor, $0, strlen($0)) }) < 0 {
            HubPerf.log("singleInstance: pid not written to the lock file (errno \(errno))")
        }
        return true
    }

    /// The pid the lock holder wrote, while that process runs.
    private static var holderPid: pid_t? {
        guard let text = try? String(contentsOf: lockFile, encoding: .utf8),
              let pid = pid_t(text.trimmingCharacters(in: .whitespacesAndNewlines)), pid != getpid(), kill(pid, 0) == 0
        else { return nil }
        return pid
    }

    /// Hands `args` to the hub that holds the lock. True when it answered. False when it never did
    /// (busy or hung): the caller still exits, since a second window would break the one-hub rule
    /// for as long as the first one lives, and says how to get a working hub back.
    static func forwardToRunningHub(_ args: [String]) -> Bool {
        for attempt in 1...forwardAttempts {
            if post(args) {
                HubPerf.log("singleInstance: handed \(args) to the running hub (attempt \(attempt))")
                return true
            }
        }
        let holder = holderPid.map { "hub (pid \($0))" } ?? "hub"
        let waited = Int(ackTimeout * Double(forwardAttempts))
        let message = "The running \(holder) did not answer in \(waited) s; it may be busy or hung. Not opening a second hub: quit that one, then run tools hub again."
        HubPerf.log("singleInstance: \(message)")
        FileHandle.standardError.write(Data("\(message)\n".utf8))
        return false
    }

    private static func post(_ args: [String]) -> Bool {
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

    /// Called by the hub that holds the lock: applies every later launch's arguments.
    static func serve(_ apply: @escaping ([String]) -> Void) {
        let center = DistributedNotificationCenter.default()
        // `.deliverImmediately` on the post is not enough for an app in the background: its own
        // suspension behaviour must let the request through as well.
        center.suspended = false
        center.addObserver(forName: request, object: nil, queue: .main) { note in
            let args = note.userInfo?["args"] as? [String] ?? []
            HubPerf.log("singleInstance: request \(args)")
            apply(args)
            center.postNotificationName(ack, object: note.object as? String, userInfo: nil, deliverImmediately: true)
        }
    }
}
