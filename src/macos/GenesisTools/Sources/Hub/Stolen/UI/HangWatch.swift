// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Sources/Genesis/UI/HangWatch.swift at 2026-09-24T04:59:16+02:00 at commit hash 0d268a43e86e6e5e0ce16132aed8c862e201923e
//
//  HangWatch.swift
//  Genesis
//
//  Main-thread stall detector with a built-in stack capture.
//
//  A background timer posts a ping block to the main queue every 250 ms and
//  measures how long it waits to run. Queue latency is the truth: a run-loop
//  Timer heartbeat (the first version) is coalesced by App Nap while Genesis
//  sits behind other apps, so an idle main thread read as a 1-2 s "stall".
//  A block on the main queue only runs late when the main thread is actually
//  busy or starved.
//
//  Stalls > 0.5 s land in PerfLog (`~/.genesis/logs/perf.log` + unified log).
//  When one crosses 1 s the watchdog runs `sample` on this process and writes
//  the main-thread call graph to `~/.genesis/logs/hangs/<time>.txt`, so the
//  stack is on disk without anyone racing `sample Genesis 3` by hand (which
//  is how the 2026-08-28 Session Details hang had to be attributed).
//

import AppKit
import Foundation
import UserNotifications

enum HangWatch {
    private static let lock = NSLock()
    /// Time the outstanding ping was posted; nil when none is waiting.
    private nonisolated(unsafe) static var pingPostedAt: CFAbsoluteTime?
    private nonisolated(unsafe) static var monitor: DispatchSourceTimer?
    private nonisolated(unsafe) static var lastSampleAt: CFAbsoluteTime = 0
    /// The sample is spawned once per stall.
    private nonisolated(unsafe) static var sampledThisStall = false
    private nonisolated(unsafe) static var lastOngoingLog: CFAbsoluteTime = 0
    /// One alert per stall, so a wedge does not post a notification a second.
    private nonisolated(unsafe) static var alertedThisStall = false
    /// Set by the test that must not raise a real user notification.
    nonisolated(unsafe) static var onWedge: ((CFAbsoluteTime) -> Void)?

    static let stallThreshold: CFAbsoluteTime = 0.5
    static let sampleThreshold: CFAbsoluteTime = 1.0
    /// Past this the main thread is not coming back on its own. The 2026-09-10
    /// wedge ran 79 MINUTES before anyone noticed, because the window keeps
    /// drawing its last frame and the app looks alive. Nothing here can run on
    /// the main thread, so the alert goes out from the watchdog's own queue.
    static let wedgeThreshold: CFAbsoluteTime = 20
    /// One `sample` per 60 s at most: it costs ~1 s of a core and a MB on disk.
    static let sampleCooldown: CFAbsoluteTime = 60
    nonisolated(unsafe) static var hangsDirectory = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".genesis-tools/logs/hangs") // GenesisTools adaptation: this app's log root.
    /// Path of the last capture, for the test that blocks the main thread.
    nonisolated(unsafe) static var lastCaptureFile: URL?

    /// `force` lets a test run the watchdog although PerfLog is off under XCTest.
    @MainActor
    static func start(force: Bool = false) {
        guard force || PerfLog.enabled, monitor == nil else { return }
        let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        timer.schedule(deadline: .now() + 1, repeating: 0.25)
        timer.setEventHandler { tick() }
        timer.resume()
        monitor = timer
        // Wall clock keeps running through system sleep. A ping posted just
        // before the lid closed would otherwise be read as an hours-long
        // stall on wake; drop it on both edges.
        let center = NSWorkspace.shared.notificationCenter
        for name in [NSWorkspace.willSleepNotification, NSWorkspace.didWakeNotification] {
            center.addObserver(forName: name, object: nil, queue: nil) { _ in
                lock.lock()
                pingPostedAt = nil
                sampledThisStall = false
                alertedThisStall = false
                lock.unlock()
            }
        }
    }

    /// Every field below is read from the timer queue, the main queue and the
    /// workspace-notification queue, so the whole check-and-set runs under the
    /// lock. `captureStack` and `PerfLog` are called after the unlock.
    private static func tick() {
        let now = CFAbsoluteTimeGetCurrent()
        lock.lock()
        guard let postedAt = pingPostedAt else {
            lock.unlock()
            post(at: now)
            return
        }
        let gap = now - postedAt
        guard gap > stallThreshold else {
            lock.unlock()
            return
        }
        var shouldSample = false
        if gap > sampleThreshold, !sampledThisStall, now - lastSampleAt > sampleCooldown {
            sampledThisStall = true
            lastSampleAt = now
            shouldSample = true
        }
        // Every 5 s while the stall is young, then once a minute: the
        // 2026-09-03 wedge wrote 180 identical lines before the app was
        // killed, and the 181st says nothing the 2nd did not.
        var shouldLog = false
        let ongoingInterval: CFAbsoluteTime = gap > 60 ? 60 : 5
        if now - lastOngoingLog > ongoingInterval {
            lastOngoingLog = now
            shouldLog = true
        }
        var shouldAlert = false
        if gap > wedgeThreshold, !alertedThisStall {
            alertedThisStall = true
            shouldAlert = true
        }
        lock.unlock()

        if shouldSample { captureStack(stallSoFar: gap) }
        if shouldLog { PerfLog.mark(String(format: "main-stall ongoing %.1fs", gap)) }
        if shouldAlert { reportWedge(stallSoFar: gap) }
    }

    private static func post(at now: CFAbsoluteTime) {
        lock.lock()
        pingPostedAt = now
        lastOngoingLog = now
        lock.unlock()
        DispatchQueue.main.async {
            let ran = CFAbsoluteTimeGetCurrent()
            lock.lock()
            let postedAt = pingPostedAt
            pingPostedAt = nil
            sampledThisStall = false
            alertedThisStall = false
            lock.unlock()
            guard let postedAt else { return }
            let ms = (ran - postedAt) * 1000
            if ms > stallThreshold * 1000 {
                PerfLog.mark(String(format: "main-stall recovered after %.0fms", ms))
            }
        }
    }

    /// Tell the user the app is wedged. A frozen main thread cannot draw an
    /// alert, show a menu-bar item or answer a click, so a local notification
    /// (delivered by the notification daemon, not by us) is the only channel
    /// left. The message names the capture so the stack is one click away.
    private static func reportWedge(stallSoFar: CFAbsoluteTime) {
        PerfLog.mark(String(format: "main-thread WEDGED for %.0fs — app will not respond", stallSoFar))
        if let onWedge {
            onWedge(stallSoFar)
            return
        }
        // GenesisTools adaptation: one bundle, no AppRole.
        guard Bundle.main.bundleIdentifier == "com.genesiscz.genesistools" else { return }
        let content = UNMutableNotificationContent()
        content.title = "GenesisTools is not responding"
        content.body = String(
            format: "The main thread has been blocked for %.0f seconds. %@",
            stallSoFar,
            lastCaptureFile.map { "Stack: ~/.genesis-tools/logs/hangs/\($0.lastPathComponent)" }
                ?? "No stack was captured."
        )
        content.sound = .default
        UNUserNotificationCenter.current().add(
            UNNotificationRequest(identifier: "genesis.hang.\(UUID().uuidString)", content: content, trigger: nil)
        )
    }

    /// Test seam: the reporter without a 20 s real stall in front of it.
    static func reportWedgeForTesting(stallSoFar: CFAbsoluteTime) {
        reportWedge(stallSoFar: stallSoFar)
    }

    /// `sample <pid> 2` from a utility thread. Only the main thread's call
    /// graph is kept; the rest of a full sample is idle worker threads.
    private static func captureStack(stallSoFar: CFAbsoluteTime) {
        let stamp = Self.fileStamp.string(from: Date())
        let file = hangsDirectory.appendingPathComponent("hang-\(stamp).txt")
        lastCaptureFile = file
        try? FileManager.default.createDirectory(at: hangsDirectory, withIntermediateDirectories: true)
        PerfLog.mark(String(format: "main-stall %.1fs so far — sampling to %@", stallSoFar, file.lastPathComponent))
        // The ping this stall belongs to. `sample` attaches ~1 s after the
        // stall was noticed and then samples for 2 s, so a 1.2 s stall is over
        // before the first sample lands and the capture shows an idle main
        // thread. 5 of the 7 captures on 2026-09-03 were that: three minutes
        // reading `mach_msg` stacks for stalls that had already recovered.
        // Recording which ping was outstanding lets the trim say so in the file
        // instead of leaving the reader to work it out.
        lock.lock()
        let stallPing = pingPostedAt
        lock.unlock()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/sample")
        process.arguments = [
            String(ProcessInfo.processInfo.processIdentifier), "2", "-mayDie",
            "-file", file.path,
        ]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        process.terminationHandler = { _ in
            lock.lock()
            let stillStalled = pingPostedAt == stallPing
            lock.unlock()
            trimToMainThread(file, stillStalled: stillStalled)
        }
        do {
            try process.run()
        } catch {
            PerfLog.mark("main-stall sample failed: \(error.localizedDescription)")
        }
    }

    /// Keep the header and the first thread (main) of the call graph; drop
    /// the per-thread sections after it and the binary image list.
    ///
    /// `stillStalled` is false when the main thread was served again while
    /// `sample` was running: the stack below is then an idle app, not the
    /// stall, and the header says so.
    static func trimToMainThread(_ file: URL, stillStalled: Bool = true) {
        guard let text = try? String(contentsOf: file, encoding: .utf8) else { return }
        var kept: [Substring] = []
        if !stillStalled {
            kept.append(Substring(
                "NOTE: the main thread recovered while this sample ran — the stack below may be an idle app, not the stall."
            ))
        }
        var threadsSeen = 0
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            if line.hasPrefix("    ") == true, line.dropFirst(4).first?.isNumber == true,
               line.contains("Thread_")
            {
                threadsSeen += 1
                if threadsSeen > 1 { break }
            }
            if line.hasPrefix("Binary Images:") { break }
            kept.append(line)
        }
        let trimmed = kept.joined(separator: "\n") + "\n"
        try? trimmed.write(to: file, atomically: true, encoding: .utf8)
    }

    private static let fileStamp: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd-HHmmss"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()
}
